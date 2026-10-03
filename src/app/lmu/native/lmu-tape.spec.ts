import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Covers the LMU tape end to end: the recorder's synthetic fixture, the
 * inspector, and playback through the replay addon.
 *
 * The replay addon is the production lmu_node.cc compiled against a
 * tape-backed source, so these also exercise the real snapshot-to-JS
 * conversion -- which is the whole reason the tape stores raw struct bytes
 * rather than already-mapped objects.
 *
 * Windows only: both artefacts are built from a gyp target that is gated on
 * OS=='win', and the struct they read is the sim's shared-memory layout.
 */

const release = path.resolve(process.cwd(), 'build', 'Release');
const exePath = path.join(release, 'lmu_replay.exe');
const addonPath = path.join(release, 'lmu_tape_node.node');
const built = fs.existsSync(exePath) && fs.existsSync(addonPath);

const describeIfBuilt = built ? describe : describe.skip;

let workDir: string | undefined;
const tapeFor = (name: string) => {
  workDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'lmu-tape-'));
  return path.join(workDir, `${name}.irlmu`);
};

const writeFixture = (tape: string, frames: number) =>
  execFileSync(
    exePath,
    ['fixture', '--output', tape, '--frames', String(frames)],
    { encoding: 'utf8' }
  );

interface TapeSdk {
  start(): boolean;
  stop(): boolean;
  isRunning(): boolean;
  read(): Record<string, unknown>;
  readSession(): Record<string, unknown>;
}

/**
 * Loads the addon fresh, because the tape source keeps its reader in module
 * state and reads the environment once when it opens.
 */
const openTape = (tape: string, speed = '100', loop = '0'): TapeSdk => {
  process.env.IRDASHIES_LMU_REPLAY = tape;
  process.env.IRDASHIES_LMU_REPLAY_SPEED = speed;
  process.env.IRDASHIES_LMU_REPLAY_LOOP = loop;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const module_ = require(addonPath) as {
    LmuSdkNode: new () => TapeSdk;
  };
  return new module_.LmuSdkNode();
};

afterAll(() => {
  delete process.env.IRDASHIES_LMU_REPLAY;
  delete process.env.IRDASHIES_LMU_REPLAY_SPEED;
  delete process.env.IRDASHIES_LMU_REPLAY_LOOP;
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

describeIfBuilt('lmu_replay tape', () => {
  it('records a tape far smaller than the frames it holds', () => {
    // A snapshot is 324,820 bytes and the sim publishes at 100 Hz, so storing
    // frames verbatim would cost ~31 MB a second. The run-length coding is
    // what makes a raw-struct tape viable at all.
    const tape = tapeFor('sized');
    writeFixture(tape, 600);

    const bytes = fs.statSync(tape).size;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(600 * 324820 * 0.01);
  });

  it('reports what the tape holds', () => {
    const tape = tapeFor('inspected');
    writeFixture(tape, 300);

    const report = execFileSync(exePath, ['inspect', '--input', tape], {
      encoding: 'utf8',
    });

    expect(report).toContain('Snapshot size:   324820 bytes');
    expect(report).toMatch(/Records: *301/);
    // One keyframe at the start, then one per interval.
    expect(report).toMatch(/Keyframes: *[1-9]/);
    expect(report).toMatch(/Deltas: *[1-9]/);
  });

  it('refuses a file that is not a tape', () => {
    const notATape = tapeFor('bogus');
    fs.writeFileSync(notATape, 'definitely not a tape');

    expect(() =>
      execFileSync(exePath, ['inspect', '--input', notATape], {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    ).toThrow();
  });

  it('plays back through the real snapshot conversion', () => {
    const tape = tapeFor('played');
    writeFixture(tape, 400);
    const sdk = openTape(tape);

    expect(sdk.start()).toBe(true);
    expect(sdk.isRunning()).toBe(true);

    let frames = 0;
    let latest: Record<string, unknown> | undefined;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && frames < 40) {
      const frame = sdk.read();
      if (frame?.running) {
        frames += 1;
        latest = frame;
      }
    }
    sdk.stop();

    expect(frames).toBeGreaterThan(0);
    // The player half of the frame is only populated when the addon finds a
    // player car, so these prove the conversion ran, not just that bytes moved.
    expect(latest?.playerHasVehicle).toBe(true);
    expect(latest?.trackName).toBe('Synthetic Circuit');
    expect(latest?.gear).toBe(4);
    expect(latest?.fuelCapacity).toBe(110);
    expect(latest?.numVehicles).toBe(2);
  });

  it('advances the recorded clock as it plays', () => {
    const tape = tapeFor('clock');
    writeFixture(tape, 400);
    const sdk = openTape(tape);
    sdk.start();

    const times: number[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && times.length < 20) {
      const frame = sdk.read();
      if (frame?.running) times.push(frame.elapsedTime as number);
    }
    sdk.stop();

    expect(times.length).toBeGreaterThan(1);
    expect(times[times.length - 1]).toBeGreaterThan(times[0]);
  });

  it('serves a session snapshot with its drivers and classes', () => {
    const tape = tapeFor('session');
    writeFixture(tape, 200);
    const sdk = openTape(tape);
    sdk.start();
    // Let at least one frame land so the reader holds a snapshot.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !sdk.read()?.running) {
      /* wait for the first frame */
    }

    const session = sdk.readSession();
    sdk.stop();

    expect(session.trackName).toBe('Synthetic Circuit');
    expect((session.drivers as unknown[])?.length).toBe(2);
  });
});
