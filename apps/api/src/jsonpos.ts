/** Locate the first syntax error in JSON text. Returns null when the text is valid JSON. */
export function locateJsonError(text: string): { line: number; column: number; message: string } | null {
  let i = 0;
  class Fail extends Error { constructor(m: string, readonly at: number) { super(m); } }
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
  const expect = (c: string) => { if (text[i] !== c) throw new Fail(`Expected '${c}'`, i); i++; };
  const str = () => {
    expect('"');
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text[i]! < ' ') throw new Fail('Control character in string', i);
      i++;
    }
    expect('"');
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws(); str(); ws(); expect(':'); value(); ws();
        if (text[i] === ',') { i++; continue; }
        expect('}'); return;
      }
    } else if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (text[i] === ',') { i++; continue; }
        expect(']'); return;
      }
    } else if (c === '"') str();
    else {
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
      if (!m) throw new Fail(i >= text.length ? 'Unexpected end of input' : `Unexpected token '${c}'`, i);
      i += m[0].length;
    }
  };
  try {
    value(); ws();
    if (i < text.length) throw new Fail(`Unexpected token '${text[i]}'`, i);
    return null;
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    const before = text.slice(0, e.at).split('\n');
    return { line: before.length, column: before[before.length - 1]!.length + 1, message: e.message };
  }
}
