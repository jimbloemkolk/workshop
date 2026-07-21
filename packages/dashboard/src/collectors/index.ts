/** Wires up every collector, starts their independent polling loops, and
 * assembles the combined /api/overview payload. This is the only module
 * that knows about all seven sources at once — each collector module stays
 * ignorant of the others. */
import type { Config } from '../config.js'
import type { HealthPoint, Overview } from '../types.js'
import { DeploysCollector } from './deploys.js'
import { HarvesterCollector } from './harvester.js'
import { HealthCollector } from './health.js'
import { PodmanCollector } from './podman.js'
import { StorageCollector } from './storage.js'
import { TlsCollector } from './tls.js'
import { VitalsCollector } from './vitals.js'

export class Collectors {
  private podman: PodmanCollector
  private health: HealthCollector
  private storage: StorageCollector
  private tls: TlsCollector
  private deploys: DeploysCollector
  private harvester: HarvesterCollector
  private vitals: VitalsCollector

  constructor(config: Config) {
    this.podman = new PodmanCollector(config)
    this.health = new HealthCollector(config)
    this.storage = new StorageCollector(config)
    this.tls = new TlsCollector(config)
    this.deploys = new DeploysCollector(config)
    this.harvester = new HarvesterCollector(config)
    this.vitals = new VitalsCollector()
  }

  /** Must be awaited before start() so the health history file is
   * compacted/loaded exactly once, before the first poll appends to it. */
  async init(): Promise<void> {
    await this.health.loadHistory()
  }

  start(): void {
    this.podman.start()
    this.health.start()
    this.storage.start()
    this.tls.start()
    this.deploys.start()
    this.harvester.start()
    this.vitals.start()
  }

  getOverview(): Overview {
    const podman = this.podman.get()
    const health = this.health.get()
    const deploys = this.deploys.get()

    return {
      ts: Date.now(),
      podman,
      health,
      storage: this.storage.get(),
      tls: this.tls.get(),
      deploys,
      harvester: this.harvester.get(),
      vitals: this.vitals.get(),
      aggregates: {
        allServicesRunning: podman ? podman.containers.every((c) => c.state === 'running') : null,
        // "main site" == the first configured health target, by convention
        mainSiteUptimePct24h: health[0]?.uptimePct['24h'] ?? null,
        lastDeploy: deploys?.[deploys.length - 1] ?? null,
      },
    }
  }

  healthHistory(name: string, hours: number): HealthPoint[] {
    return this.health.history(name, hours)
  }

  deployHistory(): Overview['deploys'] {
    return this.deploys.get()
  }
}
