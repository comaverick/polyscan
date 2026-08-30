import { createDirectionalCoverage } from './coverageModel';
import { getLiveScanAdvice, getScanCoachAdvice } from './scanCoach';

describe('getScanCoachAdvice', () => {
  it('starts from a corner', () => {
    expect(getScanCoachAdvice({ keyframes: 0 }).title).toBe('Start at one corner');
  });

  it('asks for sideways movement when depth is insufficient', () => {
    expect(getScanCoachAdvice({ keyframes: 4, evidence: { parallax: 0.01 } }).title).toBe('Create depth');
  });

  it('keeps the user in the depth phase instead of redirecting after one good frame', () => {
    expect(getScanCoachAdvice({ keyframes: 4, evidence: { parallax: 0.1 } }).title).toBe('Create depth');
  });

  it('asks for the floor only after perimeter views are captured', () => {
    expect(getScanCoachAdvice({ keyframes: 18, evidence: { parallax: 0.1 } }).title).toBe('Capture the floor');
  });

  it('asks for detail when tracking is lost', () => {
    expect(getScanCoachAdvice({ trackingState: 'lost' }).title).toBe('Find detail');
  });

  it('asks for final coverage after a full capture', () => {
    const coverage = createDirectionalCoverage().map((cell) => ({ ...cell, coverage: 0.8 }));
    expect(getScanCoachAdvice({ directionalCoverage: coverage, keyframes: 34, evidence: { parallax: 0.1 } }).title).toBe('Room coverage looks good');
  });
});

describe('getLiveScanAdvice', () => {
  const evidence = { tracking: true, usefulViewpoint: false, tooFast: false };

  it('asks the user to tap record before accepting scan views', () => {
    expect(getLiveScanAdvice({ cameraState: 'live', recording: false }).state).toBe('ready');
    expect(getLiveScanAdvice({ cameraState: 'live', recording: false }).instruction).toMatch(/tap the center/i);
  });

  it('warns about fast movement and confirms a good overlap', () => {
    expect(getLiveScanAdvice({ cameraState: 'live', recording: true, visibleDetailCount: 24, evidence: { ...evidence, tooFast: true } }).label).toBe('Slow down');
    expect(getLiveScanAdvice({ cameraState: 'live', recording: true, visibleDetailCount: 24, evidence: { ...evidence, usefulViewpoint: true }, surfaceLocked: true }).label).toBe('Surface confirmed');
  });
});
