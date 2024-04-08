import { Construct } from 'constructs';
import { Stack, StackProps, CfnOutput, Duration, RemovalPolicy, Tags } from 'aws-cdk-lib';
import { Bucket, BucketAccessControl, ObjectOwnership, BucketEncryption, EventType } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Distribution, OriginAccessIdentity, ResponseHeadersPolicy, AllowedMethods } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin, FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Vpc, SecurityGroup, IpAddresses, GatewayVpcEndpointAwsService, InterfaceVpcEndpoint, InterfaceVpcEndpointService, InterfaceVpcEndpointAwsService, Peer, Port, Instance, InstanceType, InstanceClass, InstanceSize, SubnetType, MachineImage, UserData, CfnInstanceConnectEndpoint } from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement, Effect, Role, ServicePrincipal, ArnPrincipal } from 'aws-cdk-lib/aws-iam';
import { LayerVersion, Code, Runtime, Architecture, FunctionUrlAuthType, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DatabaseCluster } from 'aws-cdk-lib/aws-docdb';
import * as path from 'path';

export class AwsAiChatbotStack extends Stack {

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Creating main VPC with Gateway Endpoint to S3
    const vpc = new Vpc(this, 'VPC', {
      vpcName: 'AWS AI ChatBot VPC',
      enableDnsHostnames: true,
      enableDnsSupport: true,
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      gatewayEndpoints: {
        S3: {
          service: GatewayVpcEndpointAwsService.S3,
        },
      },
    });

    // Creating main Security Group
    const securityGroup = new SecurityGroup(this, 'SecurityGroup', {
      //securityGroupName: 'ChatBotSecurityGroup',
      vpc,
      allowAllOutbound: true,
      description: 'AWS AI ChatBot Security Group'
    });

    // Registering VPC Interface Endpoint to Bedrock
    new InterfaceVpcEndpoint(this, 'BedrockVPCEndpoint', {
      vpc,
      service: new InterfaceVpcEndpointService(`com.amazonaws.${this.region}.bedrock-runtime`),
      privateDnsEnabled: true,
      securityGroups: [securityGroup]
    });

    // Registering VPC Interface Endpoint to CloudWatch
    new InterfaceVpcEndpoint(this, 'CloudWatchVPCEndpoint', {
      vpc,
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      securityGroups: [securityGroup]
    });

    // Creating DocumentDB Cluster
    const databaseCluster = new DatabaseCluster(this, 'Database', {
      //dbClusterName: 'AWSAIChatBotDocumentDBCluster',
      masterUser: {
        username: 'chatbot',
        excludeCharacters: '\"@/:',
      },
      instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MEDIUM),
      instances: 1,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE_WITH_EGRESS,
      },
      vpc: vpc,
      securityGroup: securityGroup,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      instanceRemovalPolicy: RemovalPolicy.DESTROY,
      securityGroupRemovalPolicy: RemovalPolicy.DESTROY,
    });

    // Adding rotation for Database password in Secrets Manager (an extra Lambda function will be deployed)
    databaseCluster.addRotationSingleUser();

    // Add rule to Security Group to allow incoming traffic to DocumentDB port (yes, for simplicity we will use the same Security Group for VPC and DB)
    securityGroup.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(databaseCluster.clusterEndpoint?.port ?? 27017), `from ${vpc.vpcCidrBlock}:${databaseCluster.clusterEndpoint?.port ?? 27017}`);

    // Creating a private bucket in S3 for documents for embedding
    const contentBucket = new Bucket(this, 'ContentBucket', {
      //bucketName: 'chatbot-content-bucket',
      removalPolicy: RemovalPolicy.DESTROY,
      accessControl: BucketAccessControl.PRIVATE,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      enforceSSL: true,
      autoDeleteObjects: true,
      encryption: BucketEncryption.S3_MANAGED,
    });

    // Creating a private bucket in S3 for ChatBot frontend html/js/css
    const websiteBucket = new Bucket(this, 'WebsiteBucket', {
      //bucketName: 'chatbot-website-bucket',
      removalPolicy: RemovalPolicy.DESTROY,
      accessControl: BucketAccessControl.PRIVATE,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
      enforceSSL: true,
      autoDeleteObjects: true,
      encryption: BucketEncryption.S3_MANAGED,
    });

    // Declaring CloudFront origin access indentity user for accessing S3
    const originAccessIdentity = new OriginAccessIdentity(this, 'OriginAccessIdentity');

    // Granting read access to origin access indentity to website bucket
    websiteBucket.grantRead(originAccessIdentity);

    // Creating CloudFront distribution for website bucket
    const websiteDistribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new S3Origin(websiteBucket, { originAccessIdentity }),
      },
    });

    // Creating a Lambda execution role
    const lambdaExecutionRole = new Role(this, 'LambdaExecutionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    // Creating VPC Access policy and add it to Lambda execution role
    const vpcAccessPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface'],
      resources: ['*'],
    });
    lambdaExecutionRole.addToPolicy(vpcAccessPolicy);

    // Creating Bedrock Access policy and add it to Lambda execution role
    const bedrockAccessPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    });
    lambdaExecutionRole.addToPolicy(bedrockAccessPolicy);

    // Creating KMS Access policy and add it to Lambda execution role
    const kmsAccessPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['kms:DescribeKey'],
      resources: ['*'],
    });
    lambdaExecutionRole.addToPolicy(kmsAccessPolicy);

    // Creating Secrets Manager Access policy and add it to Lambda execution role
    const secretsManagerAccessPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [databaseCluster.secret?.secretFullArn ?? '*'],
    });
    lambdaExecutionRole.addToPolicy(secretsManagerAccessPolicy);

    // Creating CloudWatch Access policy and add it to Lambda execution role
    const cloudWatchAccessPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    });
    lambdaExecutionRole.addToPolicy(cloudWatchAccessPolicy);

    // Creating S3 Resource policy with Lambda execution role as principal
    contentBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: [
          's3:GetObject'
        ],
        effect: Effect.ALLOW,
        principals: [
          new ArnPrincipal(lambdaExecutionRole.roleArn)
        ],
        resources: [
          contentBucket.bucketArn,
          contentBucket.arnForObjects('*')
        ],
      })
    );

    // Creating a Lambda layer with NodeJS MongoDB library (archived at Amazon Linux with NodeJS v.20)
    const mongoDBLayer = new LayerVersion(this, 'MongoDBLayer', {
      removalPolicy: RemovalPolicy.DESTROY,
      code: Code.fromAsset(path.join(__dirname, '../../lambda/layers', 'mongodb.zip')),
      compatibleArchitectures: [Architecture.X86_64],
      compatibleRuntimes: [Runtime.NODEJS_20_X],
    });

    // Creating a Lambda function responsible for creating vector index, getting vector data and embedding it to DocumentDB collection
    const embedFunction = new NodejsFunction(this, 'EmbedService', {
      //functionName: 'autoEmbedDocument',
      entry: path.join(__dirname, '../../lambda', 'embed.mjs'),
      handler: 'index.handler',
      description: 'AWS AI ChatBot Auto Embed Function',
      architecture: Architecture.X86_64,
      runtime: Runtime.NODEJS_20_X,
      role: lambdaExecutionRole,
      timeout: Duration.minutes(1),
      vpc: vpc,
      layers: [mongoDBLayer],
      securityGroups: [securityGroup],
      bundling: {
        target: 'es2022',
        format: OutputFormat.ESM,
        externalModules: [
          '@aws-sdk/client-bedrock-runtime',
          '@aws-sdk/client-secrets-manager',
          '@aws-sdk/client-s3',
          'mongodb'
        ],
        keepNames: true,
        minify: false,
        esbuildArgs: {
        },
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [
              `cp ${inputDir}/../lambda/ssl/global-bundle.pem ${outputDir}`,
            ];
          },
          beforeInstall() {
            return []
          },
          afterBundling() {
            return []
          }
        }
      },
      environment: {
        'REGION_NAME': this.region,
        'SECRET_NAME': databaseCluster.secret?.secretName ?? '',
        'DB_NAME': 'chatbot',
        'DB_DOCUMENTS_COLLECTION_NAME': 'documents',
        'DB_HISTORY_COLLECTION_NAME': 'history',
        'MAX_VECTOR_DIMENSIONS': '1536',
        'CONTENT_BUCKET': contentBucket?.bucketArn ?? '',
        'MAX_CHUNK_SIZE': '10000'
      }
    });

    // Adding a trigger for content Bucket to run embed Lambda upon new content upload 
    contentBucket.addEventNotification(EventType.OBJECT_CREATED, new LambdaDestination(embedFunction));

    // Creating a main ChatBot Lambda function that process requests using RAG (contexts from DocumentDB)
    const chatBotFunction = new NodejsFunction(this, 'ChatBotService', {
      //functionName: 'chatBotService',
      entry: path.join(__dirname, '../../lambda', 'server.mjs'),
      handler: 'index.handler',
      description: 'AWS AI ChatBot Main Service Function',
      architecture: Architecture.X86_64,
      runtime: Runtime.NODEJS_20_X,
      role: lambdaExecutionRole,
      timeout: Duration.minutes(1),
      vpc: vpc,
      layers: [mongoDBLayer],
      securityGroups: [securityGroup],
      bundling: {
        target: 'es2022',
        format: OutputFormat.ESM,
        externalModules: [
          '@aws-sdk/client-bedrock-runtime',
          '@aws-sdk/client-secrets-manager',
          'mongodb'
        ],
        keepNames: true,
        minify: false,
        esbuildArgs: {
        },
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [
              `cp ${inputDir}/../lambda/ssl/global-bundle.pem ${outputDir}`,
            ];
          },
          beforeInstall() {
            return []
          },
          afterBundling() {
            return []
          }
        }
      },
      environment: {
        'REGION_NAME': this.region,
        'SECRET_NAME': databaseCluster.secret?.secretName ?? '',
        'DB_NAME': 'chatbot',
        'DB_DOCUMENTS_COLLECTION_NAME': 'documents',
        'DB_HISTORY_COLLECTION_NAME': 'history',
        'MAX_VECTOR_DIMENSIONS': '1536'
      }
    });

    // Creating Function URL for ChatBot function
    const chatBotFunctionUrl = chatBotFunction.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: [websiteBucket.bucketWebsiteUrl],
      },
      invokeMode: InvokeMode.RESPONSE_STREAM
    });

    // Creating custom response headers policy for ChatBot Lambda CloudFront distribution
    const lambdaDistributionResponseHeadersPolicy = new ResponseHeadersPolicy(this, 'ChatBotLambdaDistributionResponseHeadersPolicy', {
      responseHeadersPolicyName: 'ChatBotLambdaDistributionPolicy',
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET', 'POST'],
        accessControlAllowOrigins: [`https://${websiteDistribution.domainName}`],
        originOverride: true,
      },
    });

    // Creating CloudFront distribution for ChatBot Lambda Function URL
    const lambdaDistribution = new Distribution(this, 'ChatBotLambdaDistribution', {
      defaultBehavior: {
        origin: new FunctionUrlOrigin(chatBotFunctionUrl),
        responseHeadersPolicy: lambdaDistributionResponseHeadersPolicy,
        allowedMethods: AllowedMethods.ALLOW_ALL,
      },
    });

    // Copy frontend html/css/js files to website bucket and also creating config.js file with link to ChatBot Lambda CloudFront distribution URL
    new BucketDeployment(this, 'WebsiteBucketDeployment', {
      sources: [Source.asset(path.join(__dirname, '../../html')), Source.data('js/config.js', `const chatBotServiceUrl = 'https://${lambdaDistribution.domainName}';`)],
      destinationBucket: websiteBucket,
      vpc: vpc
    });

    if (this.node.tryGetContext('upload-documents')) {

      // Copy documents files to content bucket (this should trigger the Embed Lambda function)
      new BucketDeployment(this, 'ContentBucketDeployment', {
        sources: [Source.asset(path.join(__dirname, '../../documents'))],
        destinationBucket: contentBucket,
        vpc: vpc,
      });

    }

    if (this.node.tryGetContext('deploy-instance')) {

      const cfnInstanceConnectEndpoint = new CfnInstanceConnectEndpoint(this, 'MyCfnInstanceConnectEndpoint', {
        subnetId: vpc.privateSubnets[0].subnetId,
        securityGroupIds: [securityGroup.securityGroupId]
      });

      // Allow inbound traffic to SSH port 22 from everywhere (to connect to instance)
      securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(22), 'allows SSH access from Internet');

      // Creating a EC2 role
      const ec2Role = new Role(this, 'EC2Role', {
        assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      });
      ec2Role.addToPolicy(vpcAccessPolicy);

      // Define commands to run after instance deploy (install mongo client)
      const ec2UserData = UserData.forLinux();
      ec2UserData.addCommands(
        'sudo sh -c \'printf "[mongodb-org-AL2023]\nname=MongoDB Repository\nbaseurl=https://repo.mongodb.org/yum/amazon/2023/mongodb-org/7.0/x86_64/\ngpgcheck=1\nenabled=1\ngpgkey=https://www.mongodb.org/static/pgp/server-7.0.asc" >> /etc/yum.repos.d/mongodb-org-7.0.repo\'',
        'sudo yum install -y mongodb-mongosh-shared-openssl3',
        'sudo wget https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -P /home/ec2-user/',
        'sudo chown ec2-user:ec2-user /home/ec2-user/global-bundle.pem'
      );

      // Provisioning EC2 instance for DB querying
      const ec2Instance = new Instance(this, 'ChatBotDBMonitoringInstance', {
        //instanceName: 'chatbot-db-monitoring-instance',
        vpc: vpc,
        role: ec2Role,
        securityGroup: securityGroup,
        instanceType: InstanceType.of(
          InstanceClass.T2,
          InstanceSize.MICRO
        ),
        machineImage: MachineImage.latestAmazonLinux2023({
          userData: ec2UserData
        }),
        //keyName: 'chatbot-db-monitoring-instance-key',
      });

    }

    // Add tag to all deployed services
    Tags.of(scope).add('Group', 'AWS AI ChatBot');

    // Displaying the final URLs
    //new CfnOutput(this, 'lambdaDistributionUrl', { value: `https://${lambdaDistribution.domainName}` });
    new CfnOutput(this, 'websiteDistributionUrl', { value: `https://${websiteDistribution.domainName}` });
  }
}
