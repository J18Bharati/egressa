// One provider, three regions, three different answers under Chapter V.
// The point of the fixture is that two of these identifiers begin `eu-` and
// only one of them is in the EEA.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SESClient } from '@aws-sdk/client-ses';

// Ireland: in the EEA.
export const documents = new S3Client({ region: 'eu-west-1' });

// London: the United Kingdom, which is adequate and not in the EEA.
export const backups = new S3Client({ region: 'eu-west-2' });

// Virginia.
export const sessions = new DynamoDBClient({ region: 'us-east-1' });

// Declared above the call and never reassigned, so it resolves.
const MAIL_REGION = 'eu-central-1';
export const mail = new SESClient({ region: MAIL_REGION });

// Supplied at deploy time. Must not resolve, and must not be guessed.
export const analytics = new S3Client({ region: process.env.AWS_REGION });
