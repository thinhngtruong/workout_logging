import Decimal from 'decimal.js';

export interface WeightUnit {
  code: string;
  aliases: string[];
  /** Exact kg per one unit, as a decimal string. */
  kgPerUnit: string;
}

/** Adding a unit is one line here (plus a test). Nothing else knows the list. */
export const WEIGHT_UNITS: WeightUnit[] = [
  { code: 'kg', aliases: ['kgs', 'kilogram', 'kilograms'], kgPerUnit: '1' },
  { code: 'lb', aliases: ['lbs', 'pound', 'pounds'], kgPerUnit: '0.45359237' },
];

const KG_DECIMALS = 5; // matches workout_sets.weight_kg numeric(12,5)
const DISPLAY_DECIMALS = 2;

export class UnitRegistry {
  private readonly byName = new Map<string, WeightUnit>();

  constructor(readonly units: WeightUnit[] = WEIGHT_UNITS) {
    for (const u of units) for (const name of [u.code, ...u.aliases]) this.byName.set(name.toLowerCase(), u);
  }

  get codes(): string[] {
    return this.units.map((u) => u.code);
  }

  /** Resolves a code or alias, case-insensitive; undefined when unsupported. */
  find(name: string): WeightUnit | undefined {
    return this.byName.get(name.trim().toLowerCase());
  }

  get(name: string): WeightUnit {
    const unit = this.find(name);
    if (!unit) throw new Error(`unsupported unit '${name}'`);
    return unit;
  }

  /** Write path: value in `unit` -> kg string rounded to 5 decimals. */
  toKg(value: number | string, unit: string): string {
    return new Decimal(value).times(this.get(unit).kgPerUnit).toDecimalPlaces(KG_DECIMALS).toFixed();
  }

  /** Read path: kg -> `unit`, rounded to 2 decimals. */
  fromKg(kg: number | string, unit: string): number {
    return new Decimal(kg).dividedBy(this.get(unit).kgPerUnit).toDecimalPlaces(DISPLAY_DECIMALS).toNumber();
  }

  /** A stored set read back: untouched in its own unit, converted from kg otherwise. */
  display(stored: { value: string; unit: string; kg: string }, target?: string): { weight: number; unit: string } {
    if (!target || this.get(target).code === stored.unit) return { weight: Number(stored.value), unit: stored.unit };
    const code = this.get(target).code;
    return { weight: this.fromKg(stored.kg, code), unit: code };
  }
}

/** The app's registry. Shared by DI (services) and route schemas (decorators cannot take injected values). */
export const unitRegistry = new UnitRegistry();
