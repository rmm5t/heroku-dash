"""Exercise the linked plugin in a real pseudo-terminal; all live access is read-only."""
import argparse
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument('--repo', help='Repository for a live read-only check; omit for offline demo')
parser.add_argument('--resources', action='store_true', help='Also verify companion costs in a live pipeline with dynos and add-ons')
args = parser.parse_args()
if args.resources and not args.repo:
    parser.error('--resources requires --repo')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
command = ['heroku', 'dash', '--read-only', '--refresh', '0']
if not args.repo:
    command.append('--demo')
process = subprocess.Popen(command, cwd=args.repo, stdin=slave, stdout=slave, stderr=slave,
                           env={**os.environ, 'TERM': 'xterm-256color'})
os.close(slave)
buffer = bytearray()


def wait_for(text, timeout=40):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rendered = re.sub(r'\x1b\[(\d+)C', lambda match: ' ' * int(match[1]), buffer.decode('utf-8', 'replace'))
        rendered = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', rendered)
        if text in rendered:
            return
        if select.select([master], [], [], 0.1)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                chunk = b''
            if not chunk:
                raise AssertionError(f'Terminal closed before {text!r}')
            buffer.extend(chunk)
    # Never dump the terminal buffer: it can contain live app metadata.
    raise AssertionError(f'Timed out waiting for {text!r}; exit={process.poll()}')


def send(keys):
    buffer.clear()
    os.write(master, keys)
    time.sleep(0.2)
    # Blessed emits incremental screen diffs. Request a full repaint so text
    # assertions don't depend on characters retained from the previous view.
    os.write(master, b'\x0c')


try:
    wait_for('Pipeline loaded')
    send(b'\r')
    wait_for('configured dynos')
    send(b'7')
    wait_for('Dyno health')
    send(b'?')
    wait_for('Keyboard shortcuts')
    send(b'?')
    send(b'2')
    send(b's')
    wait_for('Read-only mode')
    if args.resources:
        send(b'\t')  # Focus Details, then scroll down to cost/allocation fields.
        send(b'\x06')
        wait_for('Estimated cost')
        send(b'3')
        # The previous status returns once the loading animation finishes.
        wait_for('Read-only mode')
        send(b'\x06')
        wait_for('Billed cost')
    os.write(master, b'q')
    deadline = time.monotonic() + 10
    while process.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                os.read(master, 65536)
            except OSError:
                break
    assert process.wait(timeout=1) == 0
    print(f'PASS: {"live read-only" if args.repo else "offline demo"} TTY startup, app navigation, metrics, help, write blocking, {"companion cost details, " if args.resources else ""}and clean exit')
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)
