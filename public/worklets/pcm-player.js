/**
 * PCM playback worklet.
 *
 * Rime audio arrives as raw signed 16-bit mono PCM. Playing it through a
 * worklet rather than a series of AudioBufferSourceNodes buys two things that
 * barge-in depends on:
 *
 *   1. `clear` empties the queue inside the audio thread, so playback stops on
 *      the next 128-sample render quantum (~2.7 ms at 48 kHz) instead of
 *      whenever the main thread next gets scheduled.
 *   2. `played` counts samples actually rendered to the output device. That
 *      count — not wall-clock time — is what tells the heard-transcript ledger
 *      where the user's attention was cut off. A backgrounded tab keeps the
 *      clock running and stops the speaker; samples cannot lie about it.
 *
 * The queue is per-context, so audio belonging to a superseded turn can be
 * dropped by id without touching what is currently playing.
 */
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {{ contextId: string, data: Float32Array }[]} */
    this.queue = [];
    this.offset = 0;
    this.samplesPlayed = 0;
    /** Samples played, keyed by contextId. */
    this.playedByContext = new Map();
    this.reportCountdown = 0;
    this.wasPlaying = false;

    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'push') {
        this.queue.push({ contextId: message.contextId, data: message.data });
      } else if (message.type === 'clear') {
        this.queue = [];
        this.offset = 0;
        this.port.postMessage({ type: 'cleared' });
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0];
    let index = 0;

    while (index < channel.length) {
      const head = this.queue[0];
      if (!head) break;

      const remaining = head.data.length - this.offset;
      const take = Math.min(remaining, channel.length - index);
      channel.set(head.data.subarray(this.offset, this.offset + take), index);

      this.offset += take;
      index += take;
      this.samplesPlayed += take;
      this.playedByContext.set(
        head.contextId,
        (this.playedByContext.get(head.contextId) || 0) + take,
      );

      if (this.offset >= head.data.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    // Silence for the rest of the quantum when the queue runs dry.
    if (index < channel.length) channel.fill(0, index);

    const playing = this.queue.length > 0;
    if (playing !== this.wasPlaying) {
      this.wasPlaying = playing;
      this.port.postMessage({ type: playing ? 'playing' : 'drained' });
    }

    // ~20 ms of reporting cadence: often enough for the UI and the ledger,
    // rare enough not to flood the message port.
    this.reportCountdown -= channel.length;
    if (this.reportCountdown <= 0) {
      this.reportCountdown = sampleRate / 50;
      this.port.postMessage({
        type: 'played',
        total: this.samplesPlayed,
        byContext: Object.fromEntries(this.playedByContext),
      });
    }

    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
