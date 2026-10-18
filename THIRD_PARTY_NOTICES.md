# Third-party notices

This connector stands on two earlier open-source projects. Both are MIT-licensed; the
licence asks that the copyright and permission notice travel with copies of substantial
portions, which is what this file is for.

## cronometer-api-mcp — the mobile API

The mobile API client (`src/live/mobile/`, and the payload builders in `src/live/foods.ts`
and `src/live/backend.ts`) is a TypeScript implementation of the protocol established by
**Randy Westergren** in [cronometer-api-mcp](https://github.com/rwestergren/cronometer-api-mcp),
which worked it out by inspecting Cronometer's Android app. Endpoint names, the sign-in
body (including the finding that a non-null `timezone` overwrites the account's), the
auth block, the v3 delete, custom-food and recipe payloads, and the per-100 g scaling
rules all follow that project. Request shapes for notes, biometrics, exercise, barcodes
and serving edits follow pull requests against it by **paultristanwagner** (#72–#81).

Copyright (c) 2026 Randy Westergren

## cronometer-mcp — the web app protocol

Before 1.0 the live connector *was* a vendored, modified copy of `cronometer-mcp` 2.0.3 by
**Paul Hoskins**, run from Python. The GWT-RPC request bodies in `src/live/web/client.ts`
are ported from it, carrying the fixes this project made: food search moved to the JSON
endpoint (after pull requests #8 by **alex-mark** and #6 by **auctionsjeff**), refreshed
build hashes (#2 by **varunsaravagi**), reads that retry once while writes never do
(adapted from #1 by **alexey-igrychev**), and parsers that refuse what they cannot read
instead of reporting it as empty. The GWT protocol work is his, and it is the hard part.

Copyright (c) 2026 Paul Hoskins

## The MIT License (both projects)

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
