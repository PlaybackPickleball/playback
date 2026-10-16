export type TimedChunk = {
  data: Blob;
  /** Recording clock when this timeslice was flushed. The slice covers media up to this time. */
  endMs: number;
};

export type RecorderTake = {
  end: 1 | 2;
  recorder: MediaRecorder;
  stopped: Promise<Blob>;
  chunks: TimedChunk[];
  mime: string;
};

export function createRecorder(end: 1 | 2, stream: MediaStream, elapsed: () => number = () => performance.now()): RecorderTake {
  const mime = chooseMime(stream.getAudioTracks().length > 0) || chooseMime(false);
  if (!mime) throw new Error('unsupported');
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const origin = elapsed();
  const chunks: TimedChunk[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push({ data: event.data, endMs: Math.max(0, Math.round(elapsed() - origin)) });
  };
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks.map((chunk) => chunk.data), { type: mime }));
  });
  // Timeslice keeps chunks available so a last-point replay can copy them without stopping.
  recorder.start(1000);
  return { end, recorder, stopped, chunks, mime };
}

/** Flush the current timeslice. Does not pause or stop the recorder. */
export function flushRecorder(recorder: MediaRecorder): Promise<void> {
  if (recorder.state !== 'recording') return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    let quiet = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      recorder.removeEventListener('dataavailable', onData);
      window.clearTimeout(quiet);
      window.clearTimeout(timer);
      resolve();
    };
    const onData = () => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(finish, 50);
    };
    const timer = window.setTimeout(finish, 800);
    recorder.addEventListener('dataavailable', onData);
    try {
      recorder.requestData();
    } catch {
      finish();
    }
  });
}

export function chooseMime(hasAudio: boolean): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = hasAudio
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']
    : ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export function extensionFor(mime: string): 'webm' | 'mp4' {
  return mime.includes('mp4') ? 'mp4' : 'webm';
}

export type CameraFailure = 'permission' | 'missing' | 'busy' | 'insecure' | 'phone' | 'generic';

export type CameraBlock = 'phone' | 'insecure';

export type CameraClient = {
  protocol: string;
  hostname: string;
  userAgent?: string;
  requestUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
};

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function isPhoneUserAgent(userAgent: string): boolean {
  if (/iPhone|iPod/i.test(userAgent)) return true;
  return /Android/i.test(userAgent) && /Mobile/i.test(userAgent);
}

/** Phones never record. Plain HTTP is allowed only on localhost, where Chrome permits the laptop camera. */
export function cameraBlockReason(client: { protocol: string; hostname: string; userAgent?: string }): CameraBlock | null {
  if (isPhoneUserAgent(client.userAgent ?? '')) return 'phone';
  const protocol = client.protocol.toLowerCase();
  const http = protocol === 'http:' || protocol === 'http';
  if (http && !isLoopbackHostname(client.hostname)) return 'insecure';
  return null;
}

export function cameraFailure(error: unknown): CameraFailure {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : '';
  if (name === 'PhoneRecordingError') return 'phone';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'permission';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  if (name === 'SecurityError') return 'insecure';
  return 'generic';
}

function liveClient(client?: CameraClient): CameraClient {
  return {
    protocol: client?.protocol ?? globalThis.location?.protocol ?? 'http:',
    hostname: client?.hostname ?? globalThis.location?.hostname ?? '',
    userAgent: client?.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent),
    requestUserMedia: client?.requestUserMedia,
  };
}

function blockedCameraError(reason: CameraBlock): DOMException {
  if (reason === 'phone') return new DOMException('Recording stays on the laptop', 'PhoneRecordingError');
  return new DOMException('Insecure camera origin', 'SecurityError');
}

async function requestUserMedia(constraints: MediaStreamConstraints, client?: CameraClient): Promise<MediaStream> {
  const resolved = liveClient(client);
  const reason = cameraBlockReason(resolved);
  if (reason) throw blockedCameraError(reason);
  if (resolved.requestUserMedia) return resolved.requestUserMedia(constraints);
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function videoInputs(client?: CameraClient): Promise<MediaDeviceInfo[]> {
  const reason = cameraBlockReason(liveClient(client));
  if (reason) throw blockedCameraError(reason);
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
}

export async function openAssignedCameras(
  includeMic: boolean,
  assignment: { 1: string | null; 2: string | null },
  client?: CameraClient,
): Promise<{ streams: { end: 1 | 2; stream: MediaStream }[]; mic: 'on' | 'off' | 'fallback' }> {
  const ends: (1 | 2)[] = [];
  if (assignment[1]) ends.push(1);
  if (assignment[2] && assignment[2] !== assignment[1]) ends.push(2);
  const streams: { end: 1 | 2; stream: MediaStream }[] = [];
  let mic: 'on' | 'off' | 'fallback' = 'off';
  try {
    for (const [index, end] of ends.entries()) {
      const deviceId = assignment[end];
      if (!deviceId) continue;
      const video: MediaTrackConstraints = { deviceId: { exact: deviceId } };
      if (includeMic && index === 0) {
        try {
          streams.push({ end, stream: await requestUserMedia({ video, audio: true }, client) });
          mic = 'on';
          continue;
        } catch (error) {
          if (cameraFailure(error) === 'insecure' || cameraFailure(error) === 'phone') throw error;
          streams.push({ end, stream: await requestUserMedia({ video, audio: false }, client) });
          mic = 'fallback';
          continue;
        }
      }
      streams.push({ end, stream: await requestUserMedia({ video, audio: false }, client) });
    }
  } catch (error) {
    streams.forEach((item) => stopStream(item.stream));
    throw error;
  }
  return { streams, mic: includeMic ? mic : 'off' };
}

export async function openCamera(
  includeMic: boolean,
  deviceId: string,
  client?: CameraClient,
): Promise<{ stream: MediaStream; mic: 'on' | 'off' | 'fallback' }> {
  const video: MediaTrackConstraints | boolean = deviceId ? { deviceId: { exact: deviceId } } : true;
  if (!includeMic) {
    return { stream: await requestUserMedia({ video, audio: false }, client), mic: 'off' };
  }
  try {
    return { stream: await requestUserMedia({ video, audio: true }, client), mic: 'on' };
  } catch (error) {
    if (cameraFailure(error) === 'insecure' || cameraFailure(error) === 'phone') throw error;
    try {
      return { stream: await requestUserMedia({ video, audio: false }, client), mic: 'fallback' };
    } catch {
      throw error;
    }
  }
}

export async function withDuration(blob: Blob, _durationMs: number): Promise<Blob> {
  if (!blob.type.includes('webm')) return blob;
  try {
    const fix = (await import('webm-duration-fix')).default;
    return await fix(blob);
  } catch (error) {
    console.warn('Could not write WebM duration metadata', error);
    return blob;
  }
}
