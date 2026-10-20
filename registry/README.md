# Plate-format registry

One JSON file per ISO 3166-1/-2 region, licensed Apache-2.0. Each file lists the region's
patterns (anchored regexes over the normalised key), character set and confusable pairs.
Validation, OCR post-correction, keypad layouts and display formatting all read from here.
Contributions welcome: add `<REGION>.json` and a test case in `packages/core/test/plate.test.ts`.
