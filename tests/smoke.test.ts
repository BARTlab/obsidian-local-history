import {describe, expect, it} from '@jest/globals';

describe('test harness', () => {
  it('runs a passing smoke test', () => {
    expect(1 + 1).toBe(2);
  });
});
