import { FingerprintSet, FingerprintSetBuilder } from '../src/utils/fingerprintSet';

function mem(): string {
  const m = process.memoryUsage();
  return `heap=${(m.heapUsed / 1024 / 1024).toFixed(1)}MB  ext=${(m.external / 1024 / 1024).toFixed(1)}MB  RSS=${(m.rss / 1024 / 1024).toFixed(1)}MB`;
}

let cpuPrev = process.cpuUsage();
let timePrev = process.hrtime.bigint();

function cpu(): string {
  const cur = process.cpuUsage(cpuPrev);
  const timeNow = process.hrtime.bigint();
  const wallMs = Number(timeNow - timePrev) / 1e6;
  const userMs = cur.user / 1000;
  const sysMs = cur.system / 1000;
  cpuPrev = process.cpuUsage();
  timePrev = timeNow;
  return `CPU: user=${userMs.toFixed(0)}ms sys=${sysMs.toFixed(0)}ms wall=${wallMs.toFixed(0)}ms`;
}

function gc(): void {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

async function main() {
  console.log('=== FingerprintSet Memory + CPU Profile ===\n');
  gc();
  console.log(`Baseline:              ${mem()}`);

  const N = 1_000_000;
  const domains: string[] = [];
  for (let i = 0; i < N; i++) {
    if (i % 3 === 0) {
      domains.push(`||ads-${i}.example.com`);
    } else {
      domains.push(`tracker-${i}.cdn.net`);
    }
  }
  console.log(`After generate strings: ${mem()}`);

  const builder = new FingerprintSetBuilder();
  for (const d of domains) {
    if (d.startsWith('||')) {
      builder.addPipePipe(d.slice(2));
    } else {
      builder.add(d);
    }
  }
  console.log(`After builder.add x${N}: ${mem()}`);
  console.log(`  ${cpu()}`);

  domains.length = 0;
  gc();
  console.log(`\nAfter clear + GC:       ${mem()}`);

  // Phase 2: build()
  const t0 = Date.now();
  const fpSet = await builder.build();
  const buildMs = Date.now() - t0;
  console.log(`\nAfter build():          ${mem()}`);
  console.log(`  ${cpu()}`);
  console.log(`  build() wall time: ${buildMs}ms`);
  console.log(`  FingerprintSet.size = ${fpSet.size}, byteLength = ${(fpSet.byteLength / 1024 / 1024).toFixed(1)}MB`);

  gc();
  console.log(`After build() + GC:     ${mem()}`);

  // Phase 3: toUint8Array()
  const t1 = Date.now();
  const serialized = fpSet.toUint8Array();
  const serializeMs = Date.now() - t1;
  console.log(`\nAfter toUint8Array():   ${mem()}`);
  console.log(`  ${cpu()}`);
  console.log(`  toUint8Array() wall time: ${serializeMs}ms`);
  console.log(`  serialized = ${(serialized.length / 1024 / 1024).toFixed(1)}MB`);

  gc();
  console.log(`After toUint8Array + GC: ${mem()}`);

  console.log('\n=== Summary ===');
  console.log(`N domains:           ${N}`);
  console.log(`FingerprintSet size: ${fpSet.size}`);
  console.log(`FingerprintSet bytes: ${(fpSet.byteLength / 1024 / 1024).toFixed(1)}MB`);
  console.log(`Serialized bytes:    ${(serialized.length / 1024 / 1024).toFixed(1)}MB`);
  console.log(`build() time:        ${buildMs}ms`);
  console.log(`toUint8Array() time: ${serializeMs}ms`);
}

main().catch(console.error);
