import { Prisma } from '../prisma/prisma-client';
import {
  deliverySchema,
  deliveryScalarProjection,
  deliveryParentsCte,
  deliveryParentsProjection,
  deliveryParentsJoin,
} from './safety-desk-publication-delivery-evidence.query';
export function buildPublicationDeliveryCohortQuery(schema = 'public'): Prisma.Sql {
  const ns = deliverySchema(schema);
  // FLAG: Stored statuses own independent index heads. Legacy classification and
  // every parent probe occur only after the sentinel and scalar-payload bound.
  return Prisma.sql`WITH bounds AS MATERIALIZED (SELECT
    (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS observed_at,
    (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)-interval '930 seconds' AS from_at,
    (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3)-interval '30 seconds' AS until_at),
    statuses(status) AS (VALUES ('PENDING'::"ManagedBroadcastDeliveryStatus"),('SENDING'::"ManagedBroadcastDeliveryStatus"),('SENT'::"ManagedBroadcastDeliveryStatus"),('FAILED'::"ManagedBroadcastDeliveryStatus"),('AMBIGUOUS'::"ManagedBroadcastDeliveryStatus"),('CANCELED'::"ManagedBroadcastDeliveryStatus")),
    heads AS MATERIALIZED (SELECT statuses.status,head.id,head.created_at FROM statuses CROSS JOIN bounds LEFT JOIN LATERAL (
      SELECT id,created_at FROM ${ns}.managed_broadcast_deliveries WHERE dispatch_profile='PUBLIK_V1' AND status=statuses.status
        AND created_at>=bounds.from_at AND created_at<bounds.until_at ORDER BY created_at,id LIMIT 513) head ON true),
    samples AS MATERIALIZED (SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY status ORDER BY created_at,id) ordinal FROM heads WHERE id IS NOT NULL) ranked WHERE ordinal<=512),
    details AS MATERIALIZED (SELECT scalar.* FROM samples CROSS JOIN LATERAL (SELECT ${deliveryScalarProjection()} FROM ${ns}.managed_broadcast_deliveries delivery WHERE delivery.id=samples.id OFFSET 0) scalar),
    ${deliveryParentsCte(schema)}, captured AS (SELECT status,count(id)::integer AS count FROM heads GROUP BY status)
    SELECT statuses.status AS "headStatus",captured.count AS captured,bounds.observed_at AS "observedAt",bounds.from_at AS "windowStartedAt",bounds.until_at AS "windowEndedAt",
      details.*,${deliveryParentsProjection()} FROM statuses CROSS JOIN bounds JOIN captured ON captured.status=statuses.status
      LEFT JOIN details ON details.status=statuses.status ${deliveryParentsJoin()} ORDER BY statuses.status,details."createdAt",details.id`;
}
