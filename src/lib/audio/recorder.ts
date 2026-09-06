'use client';

/**
 * Utterance recorder.
 *
 * The microphone stream stays open for the whole session — that is what makes
 * barge-in possible — but recording is windowed by the VAD, so only what the
 * user actually said is uploaded for transcription.
 *
 * A short pre-roll is kept because the VAD needs ~120 ms of signal before it is
 * confident, and those 120 ms are usually the first word.
 */

const PREROLL_MS = 300;

export class UtteranceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private rolling: Blob[] = [];
  private capturing = false;

  constructor(private readonly stream: MediaStream) {}

  static supportedMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    for (const type of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';
  }

  /**
   * Starts the underlying recorder immediately and keeps a rolling pre-roll
   * buffer. `beginUtterance()` then only has to mark where to start keeping.
   */
  start(): void {
    if (this.recorder) return;

    const mimeType = UtteranceRecorder.supportedMimeType();
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      if (this.capturing) {
        this.chunks.push(event.data);
      } else {
        // Keep roughly PREROLL_MS worth; timeslice below is 100 ms.
        this.rolling.push(event.data);
        while (this.rolling.length > Math.ceil(PREROLL_MS / 100)) this.rolling.shift();
      }
    };

    recorder.start(100);
    this.recorder = recorder;
  }

  beginUtterance(): void {
    this.chunks = [...this.rolling];
    this.rolling = [];
    this.capturing = true;
  }

  /** Returns the utterance, or null if nothing usable was captured. */
  endUtterance(): Blob | null {
    if (!this.capturing) return null;
    this.capturing = false;
    const chunks = this.chunks;
    this.chunks = [];
    if (chunks.length === 0) return null;

    const type = this.recorder?.mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type });
    // Below this, it is a door slam rather than a sentence.
    return blob.size < 1200 ? null : blob;
  }

  cancelUtterance(): void {
    this.capturing = false;
    this.chunks = [];
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    this.chunks = [];
    this.rolling = [];
    this.capturing = false;
  }
}
