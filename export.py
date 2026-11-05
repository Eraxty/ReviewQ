"""Write the static site plus a queue.json snapshot, for GitHub Pages.

    python export.py _site
"""

import json
import shutil
import sys
from pathlib import Path

import crawler
from snapshot import build

SITE = Path(__file__).parent / "site"


def main(out: Path) -> None:
    crawler.init_db()
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SITE, out)
    (out / "queue.json").write_text(json.dumps(build(), separators=(",", ":")))
    print(f"wrote {out}/")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "_site"))
