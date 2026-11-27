# Content gateway contract

The HTTP contract a gateway must meet for `HTTPVolumeTransport` to read
Volumes from it. Read this to serve content to the SDK, or to see what the
SDK expects of a node's `/volumes` route.

A Volume is one root CID and the exact entries published with it. A gateway
is a bridge to Ivy and VolumeBroker for web and TypeScript clients. It is not
a second API for canonical content, and it never translates content into
JSON.

## One Volume

```http
GET /volumes/<root-CID>
Accept: application/vnd.lattice.volume
```

| Answer | Meaning                                        |
| ------ | ---------------------------------------------- |
| `200`  | The complete Volume, as below.                 |
| `404`  | The gateway cannot supply the complete Volume. |

A gateway must not answer `200` with part of a Volume. A deployment may
require an `Authorization` header. SDK requests never follow redirects, so
credentials cannot be redirected to another host.

```http
200 OK
Content-Type: application/vnd.lattice.volume
Content-Length: <bounded archive length>
```

The body is Ivy's canonical `VolumeArchive`:

```text
UInt16BE entryCount
repeat entryCount times, strictly ascending by CID string:
  UInt16BE cidUTF8Length
  cidUTF8
  UInt32BE contentLength
  content
```

| Limit                              | Value  |
| ---------------------------------- | ------ |
| Archive size                       | 64 MiB |
| Entries                            | 65,535 |
| Entries the SDK accepts by default | 4,096  |

The archive holds no duplicate CID and includes the requested root. The SDK
hashes every entry against its CID before it returns the Volume.

## Many Volumes in one request

```http
GET /volumes?cids=<root-CID>,<root-CID>,...
Accept: application/vnd.lattice.volumes
```

The answer's `Content-Type` is `application/vnd.lattice.volumes`. Its body
is one record per Volume the gateway holds:

```text
UInt16BE rootCIDLength
rootCID
UInt32BE archiveLength
archive            (as for one Volume)
```

A root the answer leaves out is not held there; the SDK reads it on its own
with the one-Volume route. `BatchingVolumeTransport` asks for at most 32
roots in a request. A gateway without this route is read one Volume at a
time from its first refusal on.

## Using a gateway from the SDK

`HTTPVolumeTransport` accepts HTTPS endpoints, and HTTP on loopback only.

A lattice-node gateway has one Volume store per hosted chain. Pass the same
path used by `NodeClient` as `chainPath`; the transport sends it as the
node's `?chainPath=Nexus/testnet` selector:

```ts
import { HTTPVolumeTransport, NodeClient, VolumeClient } from "@adalin/lattice-sdk";

const chainPath = ["Nexus", "testnet"];
const node = new NodeClient("https://ams.testnet.lattice.build", chainPath);
const volumes = new VolumeClient(
  new HTTPVolumeTransport("https://ams.testnet.lattice.build/volumes", { chainPath }),
);
```

A native application that speaks Ivy directly can implement
`VolumeTransport` without HTTP and receives the same verification after
retrieval ([API reference](api.md#transports)).
