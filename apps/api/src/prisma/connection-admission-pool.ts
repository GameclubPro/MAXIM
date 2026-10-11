import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (error?: Error | boolean) => void,
) => void;

export class ConnectionAdmissionPool extends Pool {
  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    if (!callback) {
      return new Promise<PoolClient>((resolve, reject) => {
        this.connect((error, client) => {
          if (error) reject(error);
          else if (client) resolve(client);
          else reject(new Error('PostgreSQL admission returned no connection'));
        });
      });
    }

    let retried = false;
    const acquire = () => {
      super.connect((error, client, release) => {
        // FLAG: Retry only pg-pool's expired waiting-list admission, before a client
        // or SQL reaches the caller. Query, transaction, commit and socket failures
        // never enter this branch. The pool limit and each acquisition timeout stay fixed;
        // total admission is bounded by two waits (5s + 5s with production configuration).
        if (
          !retried &&
          !client &&
          !this.ending &&
          error instanceof Error &&
          error.message === 'timeout exceeded when trying to connect'
        ) {
          retried = true;
          acquire();
          return;
        }
        callback(error, client, release);
      });
    };
    acquire();
  }
}

export class ConnectionAdmissionPrismaPg extends PrismaPg {
  constructor(
    private readonly connectionConfig: PoolConfig,
    private readonly adapterOptions?: ConstructorParameters<typeof PrismaPg>[1],
  ) {
    super(connectionConfig, adapterOptions);
  }

  override connect(): ReturnType<PrismaPg['connect']> {
    // FLAG: Each Prisma connection lifecycle owns its pool, including reconnect after
    // $disconnect. Adapter disposal must close every connection and pending admission.
    return new PrismaPg(new ConnectionAdmissionPool(this.connectionConfig), {
      ...this.adapterOptions,
      disposeExternalPool: true,
    }).connect();
  }
}
