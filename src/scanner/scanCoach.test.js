import { createDirectionalCoverage } from './coverageModel';
import { getScanCoachAdvice } from './scanCoach';

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
