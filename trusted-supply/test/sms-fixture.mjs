import { SMS_DIMENSIONS } from '../lib/sms.mjs';

export function completeSmsInput(total = 82, scorer = 'fixture-scorer') {
  if (!Number.isInteger(total) || total < 0 || total > 100) throw new TypeError('fixture total must be 0..100');
  const base = Math.floor(total / SMS_DIMENSIONS.length);
  let remainder = total % SMS_DIMENSIONS.length;
  return {
    dimensions: SMS_DIMENSIONS.map(({ key }) => ({
      key,
      score: base + (remainder-- > 0 ? 1 : 0),
      reason: `Fixture evidence for ${key}.`,
      evidence: [`fixture:${key}`],
    })),
    scorer,
  };
}
