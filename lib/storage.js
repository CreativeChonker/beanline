require('dotenv').config();
const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION || 'auto',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.STORAGE_BUCKET;

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (err) {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    // Locally (MinIO), buckets are private by default, so objects we just
    // uploaded aren't fetchable by URL. Make the bucket public-read so
    // uploadImage's returned URL actually serves the file back. In
    // production (R2), public access is instead configured via a custom
    // domain / public bucket setting outside the app — this policy call is
    // a no-op there since we only run it against MinIO's bucket lifecycle.
    try {
      await s3.send(new PutBucketPolicyCommand({
        Bucket: BUCKET,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${BUCKET}/*`],
            },
          ],
        }),
      }));
    } catch (policyErr) {
      // R2 and other S3-compatible providers may not support bucket
      // policies at all; failing to set one shouldn't break uploads.
    }
  }
}

async function uploadImage(buffer, key, contentType) {
  await ensureBucket();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return `${process.env.STORAGE_PUBLIC_URL_BASE}/${BUCKET}/${key}`;
}

module.exports = { uploadImage };
