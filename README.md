# manta-medusa

This repository is part of the Joyent Manta project.  For contribution
guidelines, issues, and general documentation, visit the main [Manta][manta]
project page.

This repository contains the reflector server and in-job agent components of
Medusa, the interactive session engine for the Joyent [Manta][manta] storage
and compute system.  Manta is an object storage system built to run
batch-oriented custom workloads on the storage nodes themselves.  Medusa, in
conjuction with the [mlogin][mlogin] client software, enables users [to run
_interactive_ workloads][blog] -- as if they were logging in to the storage
server via SSH.


## Active Branches

This repository is part of mantav1, the long term support maintenance version
of Manta. Development is done on the **[`mantav1`](../../tree/mantav1/)
branch**, the `master` branch is no longer used. See the [mantav2 overview
document](https://github.com/joyent/manta/blob/master/docs/mantav2.md) for
details on major Manta versions.


## Components

### The Reflector

This server marries up inbound connections from [`mlogin`][mlogin] clients with
inbound connections from a `medusa-agent` running in the context of a user's
[Marlin][marlin] Job.  As all connections are inbound, neither the User nor the
Marlin Job need to be able to listen for connections on a publicly accessible
IP address.

```
User:
+---------+           +---------+       +----------+
|         |websockets |         |       |          |
| mlogin  +----+----->| muskie0 +------>| medusa   |
|         |    :      |         |       | reflector|
+---------+    :      +---------+       +----------+
      x      (load       . . .               ^
     x      balanced) +---------+            |
    x          :      |         |            |
   xx    +-----+----->| muskieN +------------+
  xx     |            |         |
  x      |            +---------+       Marlin Job:
  x      |                              +----------+
  x      |websockets                    |          |
  x      +------------------------------+ medusa   |
  x                                     | agent    |
   xx                                  x+----------+
    xxxxx                           xxxx
        xxxxxxx           xxxxxxxxxxx
              xxxxxxxxxxxxx        ^
                                   |
       Interactive Shell Session --+
```

### The Agent

Interactive sessions are a regular Map or Reduce task that runs the Medusa
agent as the workload.  During the build of Medusa, that agent is parcelled up
in a self-expanding, self-executing shell archive.  That archive, shipped with
the server software, is `PUT` as a public Manta object at a well-known location
so that jobs can include and run the current version.

## License

This Source Code Form is subject to the terms of the Mozilla Public License, v.
2.0.  For the full license text see LICENSE, or http://mozilla.org/MPL/2.0/.

Copyright 2019 Joyent, Inc.



[manta]: http://github.com/joyent/manta
[marlin]: https://github.com/joyent/manta-marlin
[mlogin]: https://github.com/joyent/node-manta/blob/master/bin/mlogin
[blog]: http://blog.sysmgr.org/2013/06/manta-mlogin.html
