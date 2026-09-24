# Page labels

Page-label reading is available in the source build and is newer than the unpublished 0.2.6 draft. Page labels are read-only names supplied by a PDF's page-label number tree. They can combine a prefix with decimal, Roman, or alphabetic numbering, and the source can use duplicate, numeric, Unicode, empty, or whitespace-only labels.

When the source supports labels, PDF Workstation shows each label as secondary text beside its physical page number in the Pages pane, Organize pages, and the status bar. Empty labels are shown as `(blank label)`. The label text is rendered as text, with its supplied whitespace preserved.

Physical page numbers remain authoritative for navigation and page operations. The page number field, Page Up/Page Down, Home, End, page ranges, thumbnail selection, and move or crop controls continue to use one-based physical numbers in the interface and zero-based physical indices in native requests. A numeric-looking label does not become a navigation target.

The UI requests labels with the open document ID and revision. Native code projects source labels onto the current edited page plan for display; this projection is internal and tested against synthetic plans, and labeled-PDF structural edits that reorder or repeat pages remain refused. The UI requires a complete contiguous snapshot with one entry for every current page. A pending request, revision or tab change, stale response, malformed or partial response, and `none` or `unavailable` result immediately fall back to physical numbers.

Label reading does not edit the PDF, change page operations, or alter Save a Copy output. Encrypted, malformed, oversized, or unsupported page-label structures report unavailable and keep physical navigation usable. Label editing, label-based jumps, and label-based export ranges are not implemented.

The source frontend suite covers the snapshot validator, blank and duplicate labels, numeric and Unicode text, whitespace preservation, stale responses, revision remapping, and physical navigation. The focused native page-label gate passed 9 tests, and the full native gate passed 146 tests with 0 failures and 1 ignored test in 501.21 seconds. A mocked local-browser Organizer harness checks the rendered labels and physical selection; the standalone Tauri debug/no-bundle build also passed with 1,932 frontend modules (3.31s frontend, 42.24s native). Native desktop interaction remains unverified.
