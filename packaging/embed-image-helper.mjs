import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../apps/local-agent/src/native-image-helper.py', import.meta.url);
writeFileSync(new URL('../apps/local-agent/src/native-image-helper.ts', import.meta.url), '// Generated from native-image-helper.py by packaging/embed-image-helper.mjs.\nexport const NATIVE_IMAGE_HELPER = ' + JSON.stringify(readFileSync(source, 'utf8')) + ';\n');
