#!/usr/bin/env python3
"""A pseudo-terminal for one embedded terminal: runs a command (here `tmux attach -t <session>`)
on a pty, relays stdin -> pty and pty -> stdout, and takes resizes as JSON lines on fd 3.

    ptybridge.py <cols> <rows> -- <command…>
"""
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios


def main() -> None:
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[sys.argv.index("--") + 1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.execvp(argv[0], argv)

    def set_size(c: int, r: int) -> None:
        # the kernel sends SIGWINCH to the pty's foreground process group
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

    set_size(cols, rows)
    ctl_buf = b""
    inputs = [fd, 0, 3]
    while True:
        try:
            ready, _, _ = select.select(inputs, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break  # the app closed the terminal: detach (the tmux session lives on)
            os.write(fd, data)
        if 3 in ready:
            data = os.read(3, 4096)
            if not data:
                inputs.remove(3)
                continue
            ctl_buf += data
            while b"\n" in ctl_buf:
                line, ctl_buf = ctl_buf.split(b"\n", 1)
                try:
                    msg = json.loads(line)
                    set_size(int(msg["cols"]), int(msg["rows"]))
                except (ValueError, KeyError):
                    pass
    try:
        os.kill(pid, 1)  # SIGHUP: the tmux client detaches
        os.waitpid(pid, 0)
    except OSError:
        pass


if __name__ == "__main__":
    main()
