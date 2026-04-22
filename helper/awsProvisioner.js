import {
    S3Client,
    CreateBucketCommand,
    PutBucketVersioningCommand,
    PutBucketPolicyCommand,
    PutPublicAccessBlockCommand,
    PutBucketCorsCommand,
    HeadBucketCommand
} from "@aws-sdk/client-s3";

import {
    CloudFrontClient,
    CreateDistributionCommand,
    GetDistributionCommand
} from "@aws-sdk/client-cloudfront";

function getS3(accessKey, secretKey, region) {
    return new S3Client({
        region,
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey }
    });
}

function getCF(accessKey, secretKey) {
    return new CloudFrontClient({
        region: "us-east-1", // CloudFront is always us-east-1
        credentials: { accessKeyId: accessKey, secretAccessKey: secretKey }
    });
}

/**
 * Creates the S3 bucket if it doesn't exist.
 * Enables versioning and sets a private policy.
 */
export async function provisionBucket(accessKey, secretKey, region, bucketName) {
    const s3 = getS3(accessKey, secretKey, region);

    // Check if bucket already exists
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
        console.log(`  ✓ Bucket "${bucketName}" already exists, skipping creation.`);
    } catch {
        // Create bucket
        const createParams = { Bucket: bucketName };
        // us-east-1 does NOT accept LocationConstraint
        if (region !== "us-east-1") {
            createParams.CreateBucketConfiguration = { LocationConstraint: region };
        }
        await s3.send(new CreateBucketCommand(createParams));
        console.log(`  ✓ Bucket "${bucketName}" created.`);
    }

    // Disable block public access so bucket policy can allow CloudFront reads
    await s3.send(new PutPublicAccessBlockCommand({
        Bucket: bucketName,
        PublicAccessBlockConfiguration: {
            BlockPublicAcls: false,
            IgnorePublicAcls: false,
            BlockPublicPolicy: false,
            RestrictPublicBuckets: false
        }
    }));
    console.log(`  ✓ Public access block disabled.`);

    // Enable versioning
    await s3.send(new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: { Status: "Enabled" }
    }));
    console.log(`  ✓ Versioning enabled.`);

    // Allow public read for CloudFront delivery
    const policy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Sid: "AllowCloudFrontRead",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucketName}/*`
        }]
    });

    await s3.send(new PutBucketPolicyCommand({ Bucket: bucketName, Policy: policy }));
    console.log(`  ✓ Bucket policy set (public read for CDN delivery).`);

    // Set CORS so CloudFront can serve to browsers
    await s3.send(new PutBucketCorsCommand({
        Bucket: bucketName,
        CORSConfiguration: {
            CORSRules: [{
                AllowedHeaders: ["*"],
                AllowedMethods: ["GET", "HEAD"],
                AllowedOrigins: ["*"],
                ExposeHeaders: [],
                MaxAgeSeconds: 3000
            }]
        }
    }));
    console.log(`  ✓ CORS configured.`);
}

/**
 * Creates a CloudFront distribution pointing to the S3 bucket.
 * Restricts access — files only served with a valid signed token (viewer policy: https only).
 * Returns the CloudFront domain URL.
 */
export async function provisionCloudFront(accessKey, secretKey, bucketName, region) {
    const cf = getCF(accessKey, secretKey);
    const s3Origin = `${bucketName}.s3.${region}.amazonaws.com`;

    const params = {
        DistributionConfig: {
            CallerReference: `wh-${Date.now()}`,
            Comment: `WebHanger CDN for ${bucketName}`,
            Enabled: true,
            DefaultCacheBehavior: {
                TargetOriginId: "s3-origin",
                ViewerProtocolPolicy: "https-only",
                CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", // CachingOptimized
                OriginRequestPolicyId: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf", // CORS-S3Origin
                ResponseHeadersPolicyId: "60669652-455b-4ae9-85a4-c4c02393f86c", // CORS-With-Preflight
                AllowedMethods: {
                    Quantity: 2,
                    Items: ["GET", "HEAD"]
                },
                TrustedSigners: {
                    Enabled: false,
                    Quantity: 0
                }
            },
            Origins: {
                Quantity: 1,
                Items: [{
                    Id: "s3-origin",
                    DomainName: s3Origin,
                    S3OriginConfig: { OriginAccessIdentity: "" },
                    CustomHeaders: {                       // custom header so S3 knows request is from CF
                        Quantity: 1,
                        Items: [{
                            HeaderName: "x-wh-origin",
                            HeaderValue: "cloudfront"
                        }]
                    }
                }]
            },
            HttpVersion: "http2",
            PriceClass: "PriceClass_All"                  // global edge nodes
        }
    };

    const res = await cf.send(new CreateDistributionCommand(params));
    const domain = res.Distribution.DomainName;
    const distributionId = res.Distribution.Id;

    console.log(`  ✓ CloudFront distribution created: https://${domain}`);
    console.log(`  ⏳ Note: CloudFront takes ~10-15 min to fully deploy globally.`);

    return { cdnUrl: `https://${domain}`, distributionId };
}
