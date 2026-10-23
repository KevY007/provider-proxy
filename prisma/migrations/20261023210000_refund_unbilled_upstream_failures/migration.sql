-- One-off billing correction for the provider.texhub.ai deployment, from a request-by-request reconciliation with
-- Codex Everywhere's own usage records (2026-10-22/23): 74 failed requests that CE never billed, but that we charged
-- (an estimated input charge for requests that delivered nothing, or the delivered output of streams CE itself ended
-- with an error at its ~900 s cap). Their price / cost / profit / official price become 0, the customer is refunded,
-- and the API-key and upstream-key counters are lowered by the same amounts. The requests stay logged.
-- From now on the gateway does this itself (nothing delivered = nothing billed; provider setting unbilledStreamErrors).
-- Scoped to these exact ids, so on any other database it does nothing.

UPDATE "Provider" SET settings = settings || '{"unbilledStreamErrors": true}'::jsonb WHERE preset = 'codex-everywhere';

WITH t AS (
  SELECT id, price, cost, "userId", "apiKeyId", "providerKeyId"
  FROM "RequestLog"
  WHERE id IN (
    'f2grcqnmgvfm4gvdxhtziggf', 'q7igghch9bhow63msyeta2jj', 'lv8wx2svrg04e846woi0sw8j', 'ttil5zyqkemm7zzd4rk403f4', 'mt4qsk5ggmebrzf7xolle4n1', 'lrr7tafqwz9cepqd5d8yzqvb',
    'nio9voajuhaz9sikpgyhfv3s', 'f9nad4iadx16je2syzdheqr5', 'cwc9rirkldz2z6kmj8nyvl0w', 'laz910xlx1nrms6y89g879ci', 'aeyxrihh8bpjywgi1p280855', 'bzd4s0akg9e4f0d1vhslyj3e',
    'ckptjoz46v1lfhdv52w6xlch', 'snybcatla2i84atgs4o2ltov', 'jeijelqec3q734uen3trtv7y', 'm90ko7lvlc8n7mgidkklk40b', 'mvbd01gvw465i5xtgd1m6btx', 'behitrs11vwwspwbi5yceqpn',
    'xoucerzbil6s3v0tmyavdjep', 'qp7fbvfae3hcirbdy063vmbk', 'ka13u1puqq5myuurbw0v4ck5', 'jyvn307cooa76ux0cssihr5u', 'rb2rcjtmkpc5bo8bxm00xgm2', 'hxnlemczyhlbjf0h3xeqti2g',
    'bxoq9f0s04fuj8u5bx5l7e4w', 'madjufa5vjnmy9uj2s3uuquo', 'um6l4r6zlk09gqiawilm4k55', 'il8s4kdxqr04facera55xpl7', 'k8mq5otcc8n8zf6hgbkqnvj7', 'ya2g23gw8vn0xmk16orbamkg',
    'gz8rnzk2ouzqxfzboilqdyff', 'yrd3x61h8906bc6wm0thq9dg', 'i8kneajikxhhi369j6n9wrx6', 'ojd4vu6vzlonnwjc7cxws0hw', 'x9mjjn8kc02blysblddycleh', 'gbiwtt43b6m8nfew0xnjjfos',
    'mcwhilfgmch0w4uufsajthdc', 'cbrsgy6rau3a3jdeod8c2pxr', 'wx0bo1dt8uos2dr0h3vz1tfu', 'jq7hcricvttihnw4nn9x91m2', 'nkrzx9srumfky5gt6ab6sg2m', 'airs9de2hcb0o4tyblc0cbmw',
    'fn542v10ej78vml20spiigoy', 'svq3uz5km0ey63jg0tbx3k8y', 'dvn04jknidd4dwyvw4tu5lff', 'zfak3kv0ax5qgdip6yy4uutv', 's4cofx86gr4jlmcnh756k2x3', 't7jqhhzsl6h8hpbw2tn0p5sa',
    'v04bqpnb76bv9nrrrmyw96qe', 'bnpcaq0tvvwlb9l76xzbj3wm', 'k4uaxn1xjyaa7wxlgp7y7sl0', 'jr7fl64mzq4johzlayur52pv', 'eb3r5x79k0thtqtcfm7mz9bc', 'igk7bbhq5e19klgx1clrmnfp',
    'v4auhk6sbxfhy87ie6hwrpwk', 'euh3jvflc3thjqjjn33oo1s7', 'ic02rw09nh4b7ojlmfupqa31', 'jj5q1idlj7j6k6g4810lscjl', 'pa9f1edlqu9bw158up48qelg', 'i2kzlxiv569m9gkmxxmguc04',
    'd4uezqmff0etru1kvalsyk3v', 'ixgfuqgeg7zqrbrf90musg09', 'z100yeobgpqsuf0m8ww4iyxc', 'v3r9dkyqat9k34xhxz9oqdbk', 'f4dc8ckdpgwqlf0uuld4sb5s', 's2a9oqz0hq04z0puqfdm4nmx',
    'ummtqexbuj0qj7q4inho1g04', 'r2p6h26udcghilhl51c3yjoy', 'be8x34uo5eqpo74zwqfmxf44', 'y9hdzzzu9gmc39ioua3bdo39', 'bdkonf3do57nsq0nb64p8p9a', 'k81ccvk8blsdexwuxf1ubl16',
    'v2am4ma7vsb7qyazi0atgwtb', 'mau15xbksl2eqj8g5ek8ovhr'
  ) AND status IN ('UPSTREAM_ERROR', 'CANCELLED', 'GATEWAY_ERROR')
),
refund AS (
  UPDATE "User" u SET balance = u.balance + s.p
  FROM (SELECT "userId", sum(price) AS p FROM t WHERE "userId" IS NOT NULL GROUP BY 1) s
  WHERE u.id = s."userId"
  RETURNING u.id
),
key_spent AS (
  UPDATE "ApiKey" k SET spent = greatest(0, k.spent - s.p)
  FROM (SELECT "apiKeyId", sum(price) AS p FROM t WHERE "apiKeyId" IS NOT NULL GROUP BY 1) s
  WHERE k.id = s."apiKeyId"
  RETURNING k.id
),
upstream_totals AS (
  UPDATE "ProviderKey" pk SET "totalCost" = greatest(0, pk."totalCost" - s.c)
  FROM (SELECT "providerKeyId", sum(cost) AS c FROM t WHERE "providerKeyId" IS NOT NULL GROUP BY 1) s
  WHERE pk.id = s."providerKeyId"
  RETURNING pk.id
)
UPDATE "RequestLog" r
SET price = 0, cost = 0, profit = 0, "officialPrice" = 0,
    "internalError" = left(coalesce(r."internalError", '') || ' [refunded 2026-10-23: the upstream did not bill this request]', 4000)
WHERE r.id IN (SELECT id FROM t);