#!/usr/bin/env python3
"""查看 Windows「通知中心」数据库里最近的几条通知。

用来判断 toast 到底有没有送达系统：只要这里出现记录，就说明 PowerShell 已经成功
把通知交给了 Windows 通知平台；此时若屏幕上没有横幅，问题在系统通知设置
（或 AppID 未注册，见 README「系统通知」节），而不在插件。

用法：
    python tools/check-notifications.py [条数]

注意：数据库被系统进程占用，脚本会先复制一份再读，不会影响通知中心本身。
"""

import os
import re
import shutil
import sqlite3
import sys
import tempfile

DB = os.path.join(
    os.environ.get("LOCALAPPDATA", ""),
    "Microsoft", "Windows", "Notifications", "wpndatabase.db",
)

# 二进制 XML 里会出现的结构名，不算正文
TAGS = {
    "toast", "visual", "binding", "text", "template", "ToastGeneric",
    "actions", "action", "toastlaunch", "settingspageadvancedapps",
}


def snapshot():
    """复制数据库（含 WAL/SHM）到临时目录，避免与系统的写锁冲突。

    返回 (临时目录, 副本路径)；调用方负责删除临时目录。
    """
    if not os.path.exists(DB):
        print(f"找不到通知数据库：{DB}")
        sys.exit(1)
    tmp = tempfile.mkdtemp(prefix="wpndb-")
    for suffix in ("", "-wal", "-shm"):
        source = DB + suffix
        if os.path.exists(source):
            shutil.copy2(source, os.path.join(tmp, os.path.basename(source)))
    return tmp, os.path.join(tmp, os.path.basename(DB))


def payload_text(payload):
    """从二进制 XML 负载里抽出可读文本（标题/正文）。

    Windows 的通知负载是 binary XML，编码不固定。这里对几种常见编码各解一次，
    取可读片段最长的那份——比猜字节序稳，也不用碰字符串表结构。
    """
    if not isinstance(payload, bytes):
        return ""
    best = ""
    for codec in ("utf-8", "utf-16-le", "utf-16-be"):
        text = payload.decode(codec, "ignore")
        runs = re.findall(r"[\x20-\x7e\u4e00-\u9fff]{4,}", text)
        kept = [run.strip() for run in runs if run.strip() and run.strip() not in TAGS]
        joined = " / ".join(dict.fromkeys(kept))
        if len(joined) > len(best):
            best = joined
    return best[:240]


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    tmp, db = snapshot()
    try:
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT n.ArrivalTime AS time, h.PrimaryId AS handler, n.Payload AS payload
            FROM Notification n
            LEFT JOIN NotificationHandler h ON h.RecordId = n.HandlerId
            ORDER BY n.ArrivalTime DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    finally:
        conn.close()
        shutil.rmtree(tmp, ignore_errors=True)
    if not rows:
        print("通知数据库里没有任何记录。")
        return
    for row in rows:
        print(f"- {row['time']}  来源={row['handler']}")
        print(f"    {payload_text(row['payload'])}")


if __name__ == "__main__":
    main()
