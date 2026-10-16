/// <reference types="vite/client" />

declare module 'webm-duration-fix' {
  export default function fixWebmDuration(blob: Blob, duration?: number): Promise<Blob>;
}
