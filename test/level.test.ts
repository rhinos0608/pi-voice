import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LevelMeter, analyzePcm, classifyCapture, meterBar } from '../src/level.ts';

function sineFrame(amplitude: number, samples = 160, cycles = 4): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * cycles * i) / samples)), i * 2);
  }
  return buf;
}

describe('level', () => {
  test('all-zero buffer reports silence floor and silent-zero', () => {
    const stats = analyzePcm(Buffer.alloc(320));
    assert.equal(stats.samples, 160);
    assert.equal(stats.allZero, true);
    assert.equal(stats.rmsDbfs, -100);
    assert.equal(stats.peakDbfs, -100);
    assert.equal(classifyCapture(stats), 'silent-zero');
  });

  test('full-scale sine is near 0 dBFS peak and ok', () => {
    const stats = analyzePcm(sineFrame(32767));
    assert.equal(stats.allZero, false);
    assert.ok(stats.peakDbfs > -1, 'peak ' + stats.peakDbfs);
    assert.ok(stats.rmsDbfs > -6 && stats.rmsDbfs < 0, 'rms ' + stats.rmsDbfs);
    assert.equal(classifyCapture(stats), 'ok');
  });

  test('quiet noise classifies very-quiet', () => {
    const stats = analyzePcm(sineFrame(5));
    assert.equal(stats.allZero, false);
    assert.ok(stats.peakDbfs < -50, 'peak ' + stats.peakDbfs);
    assert.equal(classifyCapture(stats), 'very-quiet');
  });

  test('moderate signal is ok', () => {
    const stats = analyzePcm(sineFrame(8000));
    assert.equal(classifyCapture(stats), 'ok');
  });

  test('odd byte length ignores the trailing byte', () => {
    const even = sineFrame(8000, 160);
    const odd = Buffer.concat([even, Buffer.from([0x01])]);
    const a = analyzePcm(even);
    const b = analyzePcm(odd);
    assert.equal(b.samples, a.samples);
    assert.equal(b.rmsDbfs, a.rmsDbfs);
    assert.equal(b.peakDbfs, a.peakDbfs);
  });

  test('empty buffer floors at -100 dBFS', () => {
    const stats = analyzePcm(Buffer.alloc(0));
    assert.equal(stats.samples, 0);
    assert.equal(stats.rmsDbfs, -100);
    assert.equal(stats.peakDbfs, -100);
  });

  test('LevelMeter smooths toward loud frames and resets', () => {
    const meter = new LevelMeter();
    meter.push(Buffer.alloc(320));
    assert.equal(meter.db, -100);
    for (let i = 0; i < 30; i++) meter.push(sineFrame(20000));
    assert.ok(meter.db > -20, 'db ' + meter.db);
    meter.reset();
    assert.equal(meter.db, -100);
  });

  test('meterBar bounds and width', () => {
    const glyphs = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];
    assert.equal(meterBar(-100, 3), '▁▁▁');
    assert.equal(meterBar(0, 3), '▇▇▇');
    assert.equal(meterBar(-60, 3), '▁▁▁');
    assert.equal(meterBar(-10, 3), '▇▇▇');
    assert.equal(meterBar(-35).length, 3);
    assert.equal(meterBar(-35, 5).length, 5);
    const lo = glyphs.indexOf(meterBar(-50, 1));
    const hi = glyphs.indexOf(meterBar(-15, 1));
    assert.ok(hi > lo);
  });
});
