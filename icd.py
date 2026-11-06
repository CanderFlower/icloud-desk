"""iCloud Desk core entry point (compiled to icd.exe).

    icd serve                 run the API daemon in the foreground
    icd daemon ensure         start the daemon in the background if needed
    icd guide                 full CLI usage for humans and agents
"""

import sys

from app.cli import main

if __name__ == "__main__":
    sys.exit(main())
