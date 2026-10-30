import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { currentConnectionAdmissionBudget } from './connection-admission-budget';

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (error?: Error | boolean) => void,
) => void;

export class ConnectionAdmissionPool extends Pool {
  private budgetedAdmissions = 0;
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

    const budget = currentConnectionAdmissionBudget();
    if (budget) {
      try {
        budget.check();
        // FLAG: Expired Prisma maxWait callers can leave a pg waiter behind. Bound that
        // backlog, and never hand a late connection to Prisma (which would issue BEGIN).
        if (this.budgetedAdmissions >= 16) throw new Error('Read admission capacity exhausted');
      } catch (error) {
        callback(
          error instanceof Error ? error : new Error('Read admission expired'),
          undefined,
          () => {},
        );
        return;
      }
      this.budgetedAdmissions++;
    }
    let retried = false;
    const acquire = () => {
      super.connect((error, client, release) => {
        if (budget) {
          this.budgetedAdmissions--;
          try {
            budget.check();
          } catch (expired) {
            if (client) release();
            callback(
              expired instanceof Error ? expired : new Error('Read admission expired'),
              undefined,
              () => {},
            );
            return;
          }
          // A budgeted read gets one bounded admission, never the ordinary second wait.
          callback(error, client, release);
          return;
        }
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
