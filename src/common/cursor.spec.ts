import { decodeCursor, encodeCursor } from './cursor';

describe('cursor', () => {
  const pos = { performedOn: '2026-11-20', id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' };
  const filters = { exercise: 'bench', from: null, to: null, muscleGroup: null };

  it('round-trips a position for the same filters', () => {
    expect(decodeCursor(encodeCursor(pos, filters), filters)).toEqual(pos);
  });

  it('rejects a cursor reused with different filters', () => {
    const c = encodeCursor(pos, filters);
    expect(() => decodeCursor(c, { ...filters, exercise: 'squat' })).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });

  it.each(['garbage', Buffer.from('{"d":"x"}').toString('base64url'), Buffer.from('{"d":"2026-01-01","i":"1; DROP"}').toString('base64url')])(
    'rejects malformed cursor %p',
    (c) => expect(() => decodeCursor(c, filters)).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' })),
  );
});
