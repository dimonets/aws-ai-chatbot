import { S3 } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { text } from 'stream/consumers';
import { MongoClient } from 'mongodb';

// Initialize S3 client
const s3 = new S3();

// Initialize Bedrock client
const bedrock = new BedrockRuntimeClient({ region: process.env.REGION_NAME });

// Initialize Secrets Manager client
const secretsManager = new SecretsManagerClient({
  region: process.env.REGION_NAME
});

// Get Secret value for database connection
let getSecretValueResponse;
try {
  getSecretValueResponse = await secretsManager.send(
    new GetSecretValueCommand({
      SecretId: process.env.SECRET_NAME,
      VersionStage: 'AWSCURRENT'
    })
  );
} catch (error) {
  console.log('Error while trying to retrieve secrets value for db!');
  console.log(error);
  throw error;
}

// Parsing Secret value
const secret = getSecretValueResponse != null && getSecretValueResponse.SecretString != null ? JSON.parse(getSecretValueResponse.SecretString) : null;
if (!secret)
  throw new Error('Secret string is empty!');

// Build Database connection string
const DB_URL = `mongodb://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/?tls=true&tlsCAFile=global-bundle.pem&replicaSet=rs0&readPreference=secondaryPreferred&retryWrites=false`;

// Initialize Mongo DB client
const mongoDb = new MongoClient(DB_URL);

// Fetch existing indexes in documents collection
let indexes;
await mongoDb.db(process.env.DB_NAME).command({ 'listIndexes': process.env.DB_DOCUMENTS_COLLECTION_NAME })
  .then((res) => {
    indexes = res.cursor.firstBatch;
    console.log(indexes);
  })
  .catch((err) => console.log(err));

// If indexes doesn't have embeddingIdx vector index, create one
if (indexes.find((i) => i.name == 'embeddingIdx') === undefined)
  await mongoDb.db('chatbot').command({
    'createIndexes': process.env.DB_DOCUMENTS_COLLECTION_NAME,
    'indexes': [{
      'key': { 'embedding': 'vector' },
      'vectorOptions': {
        'type': 'hnsw',
        'dimensions': 1536,
        'similarity': 'euclidean',
        'm': 16,
        'efConstruction': 64
      },
      'name': 'embeddingIdx'
    }]
  }).catch((err) => console.log(err));

//  
// Main function handler that will be triggered on new documents upload to S3
//
export const handler = async (event) => {

  // Get the bucket name and object filename from the triggered event
  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

  // Get object from S3
  let response;
  try {
    response = await s3.getObject({
      Bucket: bucket,
      Key: key,
    });
  } catch (error) {
    console.error(error.message);
  }

  // Read object content (text) into string
  const data = await text(response.Body);

  if (!data || data.length == 0)
    throw new Error('File data is empty!');

  // Let's delete old records for the same filename (better than upsert because of multiple records)
  await mongoDb.db(process.env.DB_NAME).collection(process.env.DB_DOCUMENTS_COLLECTION_NAME).deleteMany({ filename: key })
    .then((res) => { })
    .catch((err) => console.log(err));

  // Split data into sections
  const sections = data.split('-----'); // Allow manual precise section splitting in text files by using separator ------
  for (let section of sections) {

    section = section.trim();

    // Split section into chunks of required size
    const numChunks = Math.ceil(section.length / process.env.MAX_CHUNK_SIZE);
    const chunks = new Array(numChunks);

    for (let i = 0, o = 0; i < numChunks; ++i, o += process.env.MAX_CHUNK_SIZE) {
      chunks[i] = section.slice(o, o + process.env.MAX_CHUNK_SIZE)
    }

    //console.log(`Extracting chunks from file: ${key}`);
    //console.log(`Chunks found: ${chunks.length}`);

    // Converting each chunk into vectors and saving it to Db
    for (const chunk of chunks) {

      // Send chunk to Bedrock to convert into vector embedding
      let vector;
      await bedrock.send(
        new InvokeModelCommand({
          modelId: 'amazon.titan-embed-text-v1',
          contentType: 'application/json',
          accept: '*/*',
          body: JSON.stringify({
            inputText: chunk
          })
        })
      )
        .then((res) => {
          vector = JSON.parse(
            Buffer.from(res.body, 'base64').toString('utf-8')
          );
          //console.log(vector);
        })
        .catch((err) => console.log(err));

      // Insert vector and data to Db
      await mongoDb.db(process.env.DB_NAME).collection(process.env.DB_DOCUMENTS_COLLECTION_NAME).insertOne({
        filename: key,
        chunk: chunk,
        embedding: vector.embedding
      })
        .then((res) => { })
        .catch((err) => console.log(err));
    }
  }

  //console.log('DONE');
};
