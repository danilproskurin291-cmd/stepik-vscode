import * as fs from 'fs';
import { once } from 'events';
import { parentPort, workerData } from 'worker_threads';
import { decoder } from '@audio/decode-mp4';
import { createMp3Encoder } from 'wasm-media-encoders';

interface AudioWorkerMessages {
    downloadFailed: string;
    noStream: string;
    noTrack: string;
}

interface AudioWorkerData {
    url: string;
    inputPath: string;
    outputPath: string;
    messages: AudioWorkerMessages;
}

type AudioWorkerMessage =
    | { type: 'progress'; phase: 'download' | 'transcode'; percent: number }
    | { type: 'done' }
    | { type: 'error'; message: string };

const CHUNK_SIZE = 1024 * 1024;
const MP3_BITRATE = 96;
const MESSAGES = (workerData as AudioWorkerData).messages;

function formatMessage(template: string, params: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
        const value = params[key];
        return value === undefined ? match : String(value);
    });
}

function post(message: AudioWorkerMessage): void {
    parentPort?.postMessage(message);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function download(url: string, inputPath: string): Promise<void> {
    post({ type: 'progress', phase: 'download', percent: 0 });

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            formatMessage(MESSAGES.downloadFailed, {
                status: response.status,
                statusText: response.statusText
            })
        );
    }

    const total = Number(response.headers.get('content-length')) || 0;
    const file = fs.createWriteStream(inputPath);

    try {
        if (!response.body) {
            throw new Error(MESSAGES.noStream);
        }
        const reader = response.body.getReader();
        let loaded = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value && value.length > 0) {
                if (!file.write(value)) {
                    await once(file, 'drain');
                }
                loaded += value.length;
                if (total > 0) {
                    post({
                        type: 'progress',
                        phase: 'download',
                        percent: Math.min(99, Math.round((loaded / total) * 100))
                    });
                }
            }
        }
    } finally {
        file.end();
        await once(file, 'finish');
    }
}

async function transcode(inputPath: string, outputPath: string): Promise<void> {
    const mp4 = await decoder();
    const encoder = await createMp3Encoder();
    let configured = false;

    const input = fs.openSync(inputPath, 'r');
    const output = fs.openSync(outputPath, 'w');
    const size = fs.fstatSync(input).size;

    const encode = (audio: Awaited<ReturnType<typeof mp4.decode>>): void => {
        if (!audio || !audio.channelData || audio.channelData.length === 0) {
            return;
        }
        if (audio.channelData[0].length === 0) {
            return;
        }
        if (!configured) {
            encoder.configure({
                sampleRate: audio.sampleRate,
                channels: audio.channelData.length > 1 ? 2 : 1,
                bitrate: MP3_BITRATE
            });
            configured = true;
        }
        const encoded = encoder.encode(audio.channelData.slice(0, 2));
        if (encoded.length > 0) {
            fs.writeSync(output, Buffer.from(encoded));
        }
    };

    try {
        let offset = 0;
        while (offset < size) {
            const length = Math.min(CHUNK_SIZE, size - offset);
            const chunk = Buffer.allocUnsafe(length);
            fs.readSync(input, chunk, 0, length, offset);
            encode(await mp4.decode(chunk));
            offset += length;
            post({
                type: 'progress',
                phase: 'transcode',
                percent: Math.min(99, Math.round((offset / size) * 100))
            });
        }

        encode(await mp4.flush());
        if (!configured) {
            throw new Error(MESSAGES.noTrack);
        }
        const tail = encoder.finalize();
        if (tail.length > 0) {
            fs.writeSync(output, Buffer.from(tail));
        }
    } finally {
        mp4.free();
        fs.closeSync(input);
        fs.closeSync(output);
    }
}

async function run(): Promise<void> {
    const { url, inputPath, outputPath } = workerData as AudioWorkerData;

    try {
        await download(url, inputPath);
        await transcode(inputPath, outputPath);
        post({ type: 'done' });
    } catch (error) {
        post({ type: 'error', message: errorText(error) });
    } finally {
        try {
            fs.unlinkSync(inputPath);
        } catch {
            // The temporary download may already be gone.
        }
    }
}

void run();
