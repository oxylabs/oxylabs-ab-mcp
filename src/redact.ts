// Redactor: scrubs every known spelling of a secret (raw, percent-encoded, base64 of user:pass) from text,
// error messages and MCP tool results so the HB password never reaches the model.

export interface RedactableContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface RedactableResult {
  content?: RedactableContent[];
  isError?: boolean;
  [key: string]: unknown;
}

interface Needle {
  value: string;
  label: string;
}

/** Replaces every known spelling of a secret (raw, percent-encoded, base64 of user:pass) in text. */
export class Redactor {
  private readonly needles: Needle[] = [];

  constructor(secrets: Array<{ name: string; value: string | undefined; username?: string }> = []) {
    for (const s of secrets) this.add(s.name, s.value, s.username);
  }

  add(name: string, value: string | undefined, username?: string): void {
    if (!value || value.length < 4) return;
    const label = `<secret>${name}</secret>`;
    const variants = new Set<string>([value, encodeURIComponent(value)]);
    if (username !== undefined) {
      const pair = Buffer.from(`${username}:${value}`, 'utf8');
      variants.add(pair.toString('base64'));
      variants.add(pair.toString('base64url'));
      variants.add(pair.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
    }
    for (const v of variants) {
      if (v.length >= 4) this.needles.push({ value: v, label });
    }
    // Longest first so a base64 token is not partially eaten by a shorter needle.
    this.needles.sort((a, b) => b.value.length - a.value.length);
  }

  text(input: string): string {
    let out = input;
    for (const n of this.needles) out = out.split(n.value).join(n.label);
    return out;
  }

  error(err: unknown): string {
    if (err instanceof Error) return this.text(err.message || String(err));
    return this.text(String(err));
  }

  result<T extends RedactableResult>(result: T): T {
    if (!result || !Array.isArray(result.content)) return result;
    return {
      ...result,
      content: result.content.map((part) =>
        part && part.type === 'text' && typeof part.text === 'string' ? { ...part, text: this.text(part.text) } : part,
      ),
    };
  }
}
