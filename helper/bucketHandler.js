import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs-extra";
import path from "path";

function getS3Client(storage) {
    const config = {
        region: storage.region || "auto",
        credentials: {
            accessKeyId: storage.accessKey,
            secretAccessKey: storage.secretKey
        }
    };

    // R2 and MinIO need a custom endpoint
    if (storage.provider === "r2" || storage.provider === "minio") {
        config.endpoint = storage.endpoint;
        config.forcePathStyle = true; // required for MinIO
    }

    return new S3Client(config);
}

/**
 * Uploads a file buffer to the configured storage provider.
 * Returns the storage path (key) of the uploaded file.
 */
export async function upload(storage, key, content) {
    if (storage.provider === "local") {
        const dest = path.join(storage.localPath, key);
        await fs.ensureDir(path.dirname(dest));
        await fs.writeFile(dest, content, "utf-8");
        return key;
    }

    const client = getS3Client(storage);
    await client.send(new PutObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Body: content,
        ContentType: "application/javascript"
    }));

    return key;
}

/**
 * Deletes a file from storage.
 */
export async function remove(storage, key) {
    if (storage.provider === "local") {
        const dest = path.join(storage.localPath, key);
        await fs.remove(dest);
        return;
    }

    const client = getS3Client(storage);
    await client.send(new DeleteObjectCommand({
        Bucket: storage.bucket,
        Key: key
    }));
}
