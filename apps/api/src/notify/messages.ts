/** Localized guest-pass messages. Placeholders are `{name}`; money and times are formatted by the caller. */
export type MessageKey = 'checked_in' | 'checked_out' | 'reminder' | 'overstay_guest' | 'overstay_host' | 'overstay_staff';
interface Tpl { subject: string; body: string }

const en: Record<MessageKey, Tpl> = {
  checked_in: { subject: 'Your guest has arrived', body: '{guest} checked in at {site} at {time} with vehicle {plate} (unit {unit}).' },
  checked_out: { subject: 'Your guest has left', body: '{guest} (vehicle {plate}) checked out at {time}. Stay: {duration}.' },
  reminder: { subject: 'Parking reminder: {hours} hours', body: 'Hi {guest}, your visitor parking for unit {unit} has been active for {hours} hours. Please check out within {limit} hours to avoid a charge of {amount}.' },
  overstay_guest: { subject: 'Parking limit reached', body: 'Hi {guest}, vehicle {plate} has not checked out after {limit} hours. A charge of {amount} will be made on the HOA platform.' },
  overstay_host: { subject: 'Your guest has exceeded the parking limit', body: '{guest} (vehicle {plate}) has not checked out after {limit} hours. A charge of {amount} will be made to unit {unit} on the HOA platform.' },
  overstay_staff: { subject: 'Guest parking limit exceeded: unit {unit}', body: 'Vehicle {plate} (guest {guest}, host unit {unit}) has not checked out after {limit} hours. A charge of {amount} will be made on the HOA platform.' },
};

const esMX: Record<MessageKey, Tpl> = {
  checked_in: { subject: 'Tu invitado ha llegado', body: '{guest} registró su entrada en {site} a las {time} con el vehículo {plate} (unidad {unit}).' },
  checked_out: { subject: 'Tu invitado se ha ido', body: '{guest} (vehículo {plate}) registró su salida a las {time}. Estancia: {duration}.' },
  reminder: { subject: 'Recordatorio de estacionamiento: {hours} horas', body: 'Hola {guest}, tu estacionamiento de visita para la unidad {unit} lleva {hours} horas activo. Registra tu salida antes de {limit} horas para evitar un cargo de {amount}.' },
  overstay_guest: { subject: 'Límite de estacionamiento alcanzado', body: 'Hola {guest}, el vehículo {plate} no ha registrado su salida después de {limit} horas. Se realizará un cargo de {amount} en la plataforma del HOA.' },
  overstay_host: { subject: 'Tu invitado excedió el límite de estacionamiento', body: '{guest} (vehículo {plate}) no ha registrado su salida después de {limit} horas. Se realizará un cargo de {amount} a la unidad {unit} en la plataforma del HOA.' },
  overstay_staff: { subject: 'Límite de estacionamiento de visitas excedido: unidad {unit}', body: 'El vehículo {plate} (invitado {guest}, anfitrión de la unidad {unit}) no ha registrado su salida después de {limit} horas. Se realizará un cargo de {amount} en la plataforma del HOA.' },
};

const esES: Record<MessageKey, Tpl> = {
  ...esMX,
  checked_in: { subject: 'Tu invitado ha llegado', body: '{guest} ha registrado su entrada en {site} a las {time} con el coche {plate} (vivienda {unit}).' },
  checked_out: { subject: 'Tu invitado se ha marchado', body: '{guest} (coche {plate}) ha registrado su salida a las {time}. Estancia: {duration}.' },
};

const ptBR: Record<MessageKey, Tpl> = {
  checked_in: { subject: 'Seu convidado chegou', body: '{guest} registrou entrada em {site} às {time} com o veículo {plate} (unidade {unit}).' },
  checked_out: { subject: 'Seu convidado saiu', body: '{guest} (veículo {plate}) registrou saída às {time}. Permanência: {duration}.' },
  reminder: { subject: 'Lembrete de estacionamento: {hours} horas', body: 'Olá {guest}, seu estacionamento de visitante da unidade {unit} está ativo há {hours} horas. Registre a saída em até {limit} horas para evitar uma cobrança de {amount}.' },
  overstay_guest: { subject: 'Limite de estacionamento atingido', body: 'Olá {guest}, o veículo {plate} não registrou saída após {limit} horas. Uma cobrança de {amount} será feita na plataforma do condomínio.' },
  overstay_host: { subject: 'Seu convidado excedeu o limite de estacionamento', body: '{guest} (veículo {plate}) não registrou saída após {limit} horas. Uma cobrança de {amount} será feita na unidade {unit} na plataforma do condomínio.' },
  overstay_staff: { subject: 'Limite de estacionamento de visitantes excedido: unidade {unit}', body: 'O veículo {plate} (convidado {guest}, anfitrião da unidade {unit}) não registrou saída após {limit} horas. Uma cobrança de {amount} será feita na plataforma do condomínio.' },
};

const fr: Record<MessageKey, Tpl> = {
  checked_in: { subject: 'Votre invité est arrivé', body: '{guest} est entré sur {site} à {time} avec le véhicule {plate} (logement {unit}).' },
  checked_out: { subject: 'Votre invité est parti', body: '{guest} (véhicule {plate}) est sorti à {time}. Durée : {duration}.' },
  reminder: { subject: 'Rappel de stationnement : {hours} heures', body: 'Bonjour {guest}, votre stationnement visiteur pour le logement {unit} est actif depuis {hours} heures. Merci d\'enregistrer votre sortie avant {limit} heures pour éviter des frais de {amount}.' },
  overstay_guest: { subject: 'Limite de stationnement atteinte', body: 'Bonjour {guest}, le véhicule {plate} n\'est pas sorti après {limit} heures. Des frais de {amount} seront prélevés sur la plateforme de la copropriété.' },
  overstay_host: { subject: 'Votre invité a dépassé la limite de stationnement', body: '{guest} (véhicule {plate}) n\'est pas sorti après {limit} heures. Des frais de {amount} seront imputés au logement {unit} sur la plateforme de la copropriété.' },
  overstay_staff: { subject: 'Limite de stationnement visiteur dépassée : logement {unit}', body: 'Le véhicule {plate} (invité {guest}, hôte du logement {unit}) n\'est pas sorti après {limit} heures. Des frais de {amount} seront prélevés sur la plateforme de la copropriété.' },
};

const de: Record<MessageKey, Tpl> = {
  checked_in: { subject: 'Ihr Gast ist angekommen', body: '{guest} ist um {time} an {site} eingefahren, Fahrzeug {plate} (Einheit {unit}).' },
  checked_out: { subject: 'Ihr Gast ist abgefahren', body: '{guest} (Fahrzeug {plate}) ist um {time} ausgefahren. Dauer: {duration}.' },
  reminder: { subject: 'Parkerinnerung: {hours} Stunden', body: 'Hallo {guest}, Ihr Besucherparkplatz für Einheit {unit} ist seit {hours} Stunden aktiv. Bitte fahren Sie innerhalb von {limit} Stunden aus, um eine Gebühr von {amount} zu vermeiden.' },
  overstay_guest: { subject: 'Parkdauer überschritten', body: 'Hallo {guest}, Fahrzeug {plate} ist nach {limit} Stunden nicht ausgefahren. Eine Gebühr von {amount} wird über die Hausverwaltungsplattform erhoben.' },
  overstay_host: { subject: 'Ihr Gast hat die Parkdauer überschritten', body: '{guest} (Fahrzeug {plate}) ist nach {limit} Stunden nicht ausgefahren. Eine Gebühr von {amount} wird für Einheit {unit} über die Hausverwaltungsplattform erhoben.' },
  overstay_staff: { subject: 'Besucher-Parkdauer überschritten: Einheit {unit}', body: 'Fahrzeug {plate} (Gast {guest}, Gastgeber Einheit {unit}) ist nach {limit} Stunden nicht ausgefahren. Eine Gebühr von {amount} wird über die Hausverwaltungsplattform erhoben.' },
};

const ar: Record<MessageKey, Tpl> = {
  checked_in: { subject: 'وصل ضيفك', body: 'سجّل {guest} دخوله إلى {site} الساعة {time} بالمركبة {plate} (الوحدة {unit}).' },
  checked_out: { subject: 'غادر ضيفك', body: 'سجّل {guest} (المركبة {plate}) خروجه الساعة {time}. مدة البقاء: {duration}.' },
  reminder: { subject: 'تذكير بالموقف: {hours} ساعات', body: 'مرحبًا {guest}، موقف الزائر للوحدة {unit} نشط منذ {hours} ساعات. يرجى تسجيل الخروج خلال {limit} ساعة لتجنب رسم قدره {amount}.' },
  overstay_guest: { subject: 'تم بلوغ حد الوقوف', body: 'مرحبًا {guest}، لم تسجّل المركبة {plate} خروجها بعد {limit} ساعة. سيُخصم رسم قدره {amount} عبر منصة اتحاد الملاك.' },
  overstay_host: { subject: 'تجاوز ضيفك حد الوقوف', body: 'لم يسجّل {guest} (المركبة {plate}) خروجه بعد {limit} ساعة. سيُخصم رسم قدره {amount} على الوحدة {unit} عبر منصة اتحاد الملاك.' },
  overstay_staff: { subject: 'تجاوز حد وقوف الزوار: الوحدة {unit}', body: 'لم تسجّل المركبة {plate} (الضيف {guest}، مضيف الوحدة {unit}) خروجها بعد {limit} ساعة. سيُخصم رسم قدره {amount} عبر منصة اتحاد الملاك.' },
};

const CATALOGS: Record<string, Record<MessageKey, Tpl>> = { en, 'es-MX': esMX, 'es-ES': esES, 'pt-BR': ptBR, fr, de, ar };

export function pickCatalog(locale: string | null | undefined): Record<MessageKey, Tpl> {
  if (!locale) return en;
  if (CATALOGS[locale]) return CATALOGS[locale]!;
  const lang = locale.split('-')[0]!;
  const hit = Object.keys(CATALOGS).find((k) => k.split('-')[0] === lang);
  return hit ? CATALOGS[hit]! : en;
}

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => v[k] ?? `{${k}}`);

export function render(locale: string | null | undefined, key: MessageKey, vars: Record<string, string>): { subject: string; body: string } {
  const t = pickCatalog(locale)[key];
  return { subject: fill(t.subject, vars), body: fill(t.body, vars) };
}
