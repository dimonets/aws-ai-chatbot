# Welcome to AWS AI ChatBot

This is a test project for AWS AI ChatBot development with RAG using Bedrock, Lambda, DocumentDB.

## Prerequisites

Amazon AWS account with activated access to models in AWS Bedrock service:
- Amazon Titan Embedding G1 - Text
- Anthropic Claude 3 Sonnet

## Installation commands

1) Install AWS CLI as described here (if not yet installed):
https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-getting-started.html
* `aws --version`  to test if AWS CLI installed and its version 

1) Install AWS CDK CLI (if not yet installed):
* `aws sso login`  to start AWS portal session
* `aws sts get-caller-identity`  to test if session exists and to get current account number
* `npm install -g aws-cdk`  to install AWS CDK CLI

2) Bootstrap your CDK environment and configure default region to one that has Bedrock service (for example: us-east-1):
* `cdk bootstrap aws://ACCOUNT-NUMBER/REGION`  to bootstrap CDK environment for specific account and region (if not yet bootstraped)
* `aws configure get region`  to check currently set region
* `aws configure set region us-east-1`  to set another region (in this example: us-east-1)

3) Deploy infrastructure using AWS CDK CLI from ./cdk folder:
* `npm install`  install dependencies
* `npx cdk synth`   verify and emit the synthesized CloudFormation template (see possible parameters below)
* `npx cdk deploy`  deploy this stack to your default AWS account/region (see possible parameters below)
* `npx cdk diff`    compare deployed stack with current state
Possible parameters for deploying:
- `upload-documents=true` (default - false) will process files embedding automatically at moment of deploying
- `deploy-instance=true` (default - false) will deploy EC2 micro instance in VPC to query DocumentDB data for review
Sample commands with extra parameters:
* `npx cdk synth -c upload-documents=true -c deploy-instance=true` 
* `npx cdk deploy -c upload-documents=true -c deploy-instance=true`

## Run application in browser
After successfull deployment with `npx cdk deploy` there will be an output like:
AwsAiChatbotStack.websiteDistributionUrl = https://**************.cloudfront.net
Copy and paste this URL into the browser window.

## Manually uploading documents
If you didn't choose to upload documents at the moment of deploying, you can upload it manually in S3 to content bucket. Embed lambda function will be immediatelly triggered and documents will be converted into the embedding vectors.

## Using monitoring EC2 instance
If you chose to deploy monitoring EC2 instance you can connect to it via AWS Console using EC2 Instance Connect Endpoint (to connect to private IP4 address), and then run commands to connect to mongo per instructions provided at DocumentDB cluster page, but instead of `mongo` use `mongosh`. You can find connection password at AWS Secrets Manager.

## Demo purpose note
This application is only for demo purposes and not for production use. For production use several improvements must be done: 
- on AWS level: use separate AWS roles and separate security groups, consider having lambda step functions for main service, add WAF with CloudFront, add AWS Textract for PDF files processing etc
- on application level: improve error handling, add security hash to prevent unauthorized use, provide a history as context, supply more than one context chunk, add security guardrails into prompts etc.
