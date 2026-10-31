/**
 * Escaping by construction. A template value is either a plain string (escaped when inserted)
 * or a `Safe` fragment that was built from escaped pieces. There is no allow-list of "raw" keys:
 * the only way to put markup into the page is to produce a `Safe`, and the `html` tag escapes
 * every interpolation that is not already `Safe`.
 */
import { escapeHtml } from "../markdown.ts";

export class Safe {
  readonly #html: string;
  constructor(html: string) {
    this.#html = html;
  }
  toString(): string {
    return this.#html;
  }
}

export type Value = string | Safe;

/** Mark a string that is already valid, escaped HTML (the caller takes responsibility). */
export const raw = (markup: string): Safe => new Safe(markup);

/** Escape a string; pass a Safe through unchanged. */
export const toHtml = (value: Value | number | null | undefined): string =>
  value instanceof Safe ? value.toString() : value === null || value === undefined ? "" : escapeHtml(String(value));

/** Tagged template: literal parts are trusted, interpolations are escaped unless Safe (arrays are joined). */
export function html(strings: TemplateStringsArray, ...values: Array<Value | number | null | undefined | Array<Value>>): Safe {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += Array.isArray(value) ? value.map(toHtml).join("") : toHtml(value);
    out += strings[i + 1] ?? "";
  });
  return new Safe(out);
}

/** Join Safe fragments. */
export const join = (parts: Safe[], separator = ""): Safe => new Safe(parts.map(String).join(separator));

/** Fill `{{KEY}}` placeholders: strings are escaped, Safe values inserted as they are, missing keys become "". */
export function fill(template: string, values: Record<string, Value>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => toHtml(values[key]));
}

/** Remove a `<!-- block:start --> ... <!-- block:end -->` region from the template. */
export function stripBlock(template: string, block: string): string {
  return template.replace(new RegExp(`<!-- ${block}:start -->[\\s\\S]*?<!-- ${block}:end -->`), "");
}
