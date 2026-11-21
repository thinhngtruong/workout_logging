import { UnitRegistry, WEIGHT_UNITS } from './unit-registry';

describe('UnitRegistry', () => {
  const units = new UnitRegistry();

  it('normalizes lb to kg exactly, rounded to 5 decimals', () => {
    expect(units.toKg(225, 'lb')).toBe('102.05828');
    expect(units.toKg('100', 'kg')).toBe('100');
  });

  it('resolves aliases case-insensitively and rejects unknown units', () => {
    expect(units.find('LBS')?.code).toBe('lb');
    expect(units.find(' Kilogram ')?.code).toBe('kg');
    expect(units.find('stone')).toBeUndefined();
    expect(() => units.toKg(1, 'oz')).toThrow("unsupported unit 'oz'");
  });

  it('returns the logged value untouched when read in its own unit (no round-trip drift)', () => {
    const stored = { value: '225.00', unit: 'lb', kg: units.toKg(225, 'lb') };
    expect(units.display(stored, 'lb')).toEqual({ weight: 225, unit: 'lb' });
    expect(units.display(stored)).toEqual({ weight: 225, unit: 'lb' });
    expect(units.display(stored, 'kg')).toEqual({ weight: 102.06, unit: 'kg' });
  });

  it('round-trips every value 0..500 lb in 0.25 steps back to the same 2-decimal value', () => {
    for (let v = 0; v <= 500; v += 0.25) expect(units.fromKg(units.toKg(v, 'lb'), 'lb')).toBe(v);
  });

  it('supports a new unit with a single registry entry and no other change', () => {
    const withStone = new UnitRegistry([...WEIGHT_UNITS, { code: 'st', aliases: ['stone'], kgPerUnit: '6.35029318' }]);
    expect(withStone.codes).toEqual(['kg', 'lb', 'st']);
    expect(withStone.toKg(10, 'stone')).toBe('63.50293');
    expect(withStone.display({ value: '140', unit: 'lb', kg: withStone.toKg(140, 'lb') }, 'st')).toEqual({ weight: 10, unit: 'st' });
  });
});
