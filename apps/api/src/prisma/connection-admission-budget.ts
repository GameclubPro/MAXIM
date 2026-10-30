import { AsyncLocalStorage } from 'node:async_hooks';

export type ConnectionAdmissionBudget = { check(): void };
const admissionBudget = new AsyncLocalStorage<ConnectionAdmissionBudget>();

/** Only opted-in reads change admission behavior; ordinary pool callers retain their policy. */
export const currentConnectionAdmissionBudget = () => admissionBudget.getStore();
export function withConnectionAdmissionBudget<T>(
  budget: ConnectionAdmissionBudget,
  read: () => T,
): T {
  return admissionBudget.run(budget, read);
}
