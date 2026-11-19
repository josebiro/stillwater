const MAX_CLOCK_GAP_SAMPLES = 512; // 32 ms at 16 kHz
const MAX_REPAIRED_SAMPLES = 1024;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = [new Int16Array(2048), new Int16Array(2048)];
    this.length = 0;
    this.offsetSamples = 0;
    this.repairedSamples = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "pause" || data === "resume") {
        this.paused = data === "pause";
        this.nextRenderFrame = undefined;
        this.port.postMessage({ paused: this.paused });
        return;
      }
      if (data !== "stop" || this.stopped) return;
      this.stopped = true;
      this.flush();
      this.port.postMessage({ stopped: true });
    };
  }

  flush() {
    if (this.length === 0) return;
    const frames = this.frames.map((frame) => frame.subarray(0, this.length));
    this.port.postMessage({ offsetSamples: this.offsetSamples, frames },
      frames.map((frame) => frame.buffer));
    this.offsetSamples += this.length;
    this.frames = [new Int16Array(2048), new Int16Array(2048)];
    this.length = 0;
  }

  process(inputs, outputs) {
    if (this.stopped) return false;
    if (this.paused) return true;
    const blockSize = outputs[0][0].length;
    const gap = currentFrame - (this.nextRenderFrame ?? currentFrame);
    if (gap < 0 || gap > MAX_CLOCK_GAP_SAMPLES || this.repairedSamples + gap > MAX_REPAIRED_SAMPLES) {
      this.flush();
      this.port.postMessage({ clockGap: { gap, repairedSamples: this.repairedSamples } });
      return false;
    }
    this.repairedSamples += gap;
    this.nextRenderFrame = currentFrame + blockSize;
    for (let index = 0; index < gap; index++) {
      this.length++;
      if (this.length === this.frames[0].length) this.flush();
    }
    const microphone = inputs[0]?.[0];
    const system = inputs[1]?.[0];
    for (let index = 0; index < blockSize; index++) {
      const micSample = Math.max(-1, Math.min(1, microphone?.[index] ?? 0));
      const systemSample = Math.max(-1, Math.min(1, system?.[index] ?? 0));
      this.frames[0][this.length] = micSample * (micSample < 0 ? 32768 : 32767);
      this.frames[1][this.length] = systemSample * (systemSample < 0 ? 32768 : 32767);
      this.length++;
      if (this.length === this.frames[0].length) this.flush();
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
