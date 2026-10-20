import { InventoryDoc, type RateRules } from '@openpark/core';

export interface CountryDefaults {
  locale: string; currency: string; timezone: string; plateRegions: string[]; rules: RateRules;
}

const mk = (r: Partial<RateRules> & Pick<RateRules, 'firstPeriodFee' | 'incrementFee'>): RateRules => ({
  graceMin: 10, firstPeriodMin: 60, incrementMin: 15, dailyCap: null, lostTicketFee: 0, taxMode: 'none', taxRate: 0, ...r,
});

/** Country templates: locale, currency, timezone, plate regions and a starter hourly rate plan. */
export const COUNTRIES: Record<string, CountryDefaults> = {
  MX: { locale: 'es-MX', currency: 'MXN', timezone: 'America/Mexico_City', plateRegions: ['MX'],
    rules: mk({ firstPeriodFee: 3000, incrementFee: 1000, dailyCap: 25000, lostTicketFee: 30000, taxMode: 'included', taxRate: 0.16 }) },
  US: { locale: 'en', currency: 'USD', timezone: 'America/New_York', plateRegions: ['US'],
    rules: mk({ firstPeriodFee: 500, incrementFee: 200, dailyCap: 3000, lostTicketFee: 4000 }) },
  BR: { locale: 'pt-BR', currency: 'BRL', timezone: 'America/Sao_Paulo', plateRegions: ['BR'],
    rules: mk({ firstPeriodFee: 1200, incrementFee: 500, dailyCap: 8000, lostTicketFee: 10000 }) },
  DE: { locale: 'de', currency: 'EUR', timezone: 'Europe/Berlin', plateRegions: ['DE'],
    rules: mk({ firstPeriodFee: 300, incrementFee: 100, dailyCap: 2500, lostTicketFee: 3000, taxMode: 'included', taxRate: 0.19 }) },
  FR: { locale: 'fr', currency: 'EUR', timezone: 'Europe/Paris', plateRegions: ['FR'],
    rules: mk({ firstPeriodFee: 300, incrementFee: 100, dailyCap: 2500, lostTicketFee: 3000, taxMode: 'included', taxRate: 0.2 }) },
  ES: { locale: 'es-ES', currency: 'EUR', timezone: 'Europe/Madrid', plateRegions: ['ES'],
    rules: mk({ firstPeriodFee: 300, incrementFee: 100, dailyCap: 2500, lostTicketFee: 3000, taxMode: 'included', taxRate: 0.21 }) },
};
export const DEFAULT_COUNTRY: CountryDefaults = { ...COUNTRIES.US!, plateRegions: ['US'] };

/** Sample inventory seeded into every new tenant: 40 standard, 4 EV, 2 accessible, 6 motorcycle slots. */
export function demoInventory(tenant: string, timezone: string): InventoryDoc {
  return InventoryDoc.parse({
    schemaVersion: 1,
    tenant,
    slotTypes: [
      { code: 'standard', label: { en: 'Standard', 'es-MX': 'Estándar' } },
      { code: 'ev', label: { en: 'EV charging', 'es-MX': 'Carga eléctrica' } },
      { code: 'accessible', label: { en: 'Accessible', 'es-MX': 'Accesible' } },
      { code: 'moto', label: { en: 'Motorcycle', 'es-MX': 'Motocicleta' } },
    ],
    sites: [{
      code: 'DEMO-01', name: 'Demo Site', timezone,
      zones: [
        { code: 'B1', name: { en: 'Basement 1', 'es-MX': 'Sótano 1' }, level: -1, slots: [
          { range: 'B1-001..B1-040', type: 'standard' },
          { range: 'B1-E01..B1-E04', type: 'ev', attributes: { chargerKw: 11 } },
          { range: 'B1-A01..B1-A02', type: 'accessible' },
          { range: 'B1-M01..B1-M06', type: 'moto' },
        ] },
      ],
    }],
  });
}
