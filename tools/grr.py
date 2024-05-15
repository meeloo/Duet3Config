#!/usr/bin/env python3

# tested on python3

import argparse
import ctypes
import hashlib
import http
import json
import os
import socket
import sqlite3
import sys
import urllib.parse
import urllib.request
import time
import zlib

from urllib.parse import urlsplit, urlunsplit

STATUS_FILE = ".rrf_mirror"

RRF_FILELIST     = '%s/rr_filelist?first=%d&dir=0%%3A%%2F%s'
RRF_DOWNLOAD     = '%s/rr_download?name=0%%3A%%2F%s'
RRF_UPLOAD       = '%s/rr_upload?name=0%%3A%%2F%s&time=%s&crc32=%s'
RRF_OBJECT_MODEL = '%s/rr_model?flags=d99fn'
RRF_SEQS         = '%s/rr_model?key=seqs.reply'
RRF_GCODE        = '%s/rr_gcode?gcode=%s'
RRF_SHA1_FILE    = 'M38 "/%s"'
RRF_REPLY        = '%s/rr_reply'

def find_base(cwd):
  abspath = os.path.abspath(cwd)
  pathcomps = os.path.split(abspath)
  files = os.listdir(cwd)
  mirror_file = os.path.join(abspath, STATUS_FILE)
  if os.path.exists(mirror_file):
    return os.path.split(mirror_file)[0]
  if pathcomps[1] == '':
    return None
  else:
    return find_base(pathcomps[0])

def validate_state(parser):
  base = find_base(os.curdir)
  if base is None:
    parser.error(
      STATUS_FILE + " not found, configuration has not been mirrored yet")
    sys.exit(1)
  else:
    return base

def main():
  parser = argparse.ArgumentParser(
    description = "Mirror remote RRF configuration")
  parser.add_argument("-m", "--mirror", type=str,
    help="Copy remote RRF configuration to local directory, MIRROR is DWC URL")
  parser.add_argument("-d", "--directory", type=str,
    help="Destination directory, required with MIRROR")
  parser.add_argument("-r", "--refresh", const=True, action='store_const',
    help="Refresh files from RRF")
  parser.add_argument("-u", "--upload", const=True, action='store_const',
    help="Upload modified files")
  parser.add_argument("-e", "--execute", type=str,
    help="Execute a GCode command")
  args = parser.parse_args()

  if args.mirror and args.directory:
    do_mirror(args.mirror, args.directory)
  elif args.execute:
    do_execute(validate_state(parser), args.execute)
  elif args.mirror or args.directory:
    parser.error("MIRROR and DIRECTORY options must be used together")
  elif args.upload:
    upload_local_changes(validate_state(parser))
  elif args.refresh:
    do_refresh(validate_state(parser))
  else:
    check_local_status(validate_state(parser))

def sanitize_mirror_prefix(mirror_prefix):
  parts = urlsplit(mirror_prefix)
  if parts.netloc.endswith(".local"):
    host = socket.gethostbyname(parts.netloc)
    parts = parts._replace(netloc=host)
    mirror_prefix = urlunsplit(parts)
  return mirror_prefix

def get_mirror_prefix(db):
  return sanitize_mirror_prefix(next(db.execute("select prefix from mirror"))[0])

def do_mirror(mirror_prefix, basedir):
  print("Mirroring configuration from %s into %s" % (mirror_prefix, basedir))
  while mirror_prefix.endswith("/"):
    mirror_prefix = mirror_prefix[:-1]

  if not os.path.exists(basedir):
    os.makedirs(basedir)
  basedir = os.path.abspath(basedir)
  status_db = os.path.join(basedir, STATUS_FILE)
  if os.path.exists(status_db):
    os.remove(status_db)

  db = sqlite3.connect(status_db)
  db.execute("""
    create table mirror (
      prefix TEXT NOT NULL
    );
  """)
  db.execute("""
    create table file_info (
      basedir TEXT NOT NULL,
      name TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (basedir, name)
    );
  """)
  db.execute("insert into mirror (prefix) values (?)", (mirror_prefix,));
  mirror_prefix = sanitize_mirror_prefix(mirror_prefix)
  if not os.path.exists(basedir):
    os.makedirs(basedir)
  os.chdir(basedir)
  if not os.path.exists("sys"):
    os.makedirs("sys")
  os.chdir("sys")
  listfiles(db, mirror_prefix, "sys")
  os.chdir("..")
  if not os.path.exists("macros"):
    os.makedirs("macros")
  os.chdir("macros")
  listfiles(db, mirror_prefix, "macros")
  os.chdir("..")
  if not os.path.exists("filaments"):
    os.makedirs("filaments")
  os.chdir("filaments")
  listfiles(db, mirror_prefix, "filaments")
  os.chdir("..")
  if not os.path.exists("menu"):
    os.makedirs("menu")
  os.chdir("menu")
  listfiles(db, mirror_prefix, "menu")
  os.chdir("..")
  db.commit()
  db.close()

def walk_handler(arg, dirname, fnames):
  basedir = dirname[len(arg['basedir']) + 1:]
  if basedir == "":
    return
  if basedir.startswith(".") or "/." in basedir.replace("\\", "/"):
    return
  fnames.sort()
  files = [x for x in fnames
    if os.path.isfile(os.path.join(dirname,x)) and not x.startswith(".")]
  for x in files:
    if x.startswith("."):
      continue
    f = os.path.join(basedir, x)
    # replace \ with / for windows
    dgs = list(arg['db'].execute(
      "select digest from file_info where basedir = ? and name = ?",
      (basedir.replace('\\', '/') ,x)))
    current_digest = digest(basedir, f)
    if len(dgs) > 0:
      if current_digest != dgs[0][0]:
        print("\t*", f)
        arg['changes'] = True
        arg['updated'].append((f, current_digest))
    else:
      print("\t+", f)
      arg['changes'] = True
      arg['new'].append((f, current_digest))

def check_local_status(basedir):
  print(basedir + " > Local changes found:\n")
  basedir = os.path.abspath(basedir)
  os.chdir(basedir)
  status_db = os.path.join(basedir, STATUS_FILE)
  db = sqlite3.connect(status_db)
  arg = {
    'db': db,
    'basedir': basedir,
    'changes': False,
    'new': [],
    'updated': []
  }
  for (dirent, subdir, files) in os.walk(basedir):
      walk_handler(arg, dirent, files)

  db.close()
  if not arg['changes']:
    print("\tNone\n")
  else:
    print()

def do_execute(basedir, gcode):
  status_db = os.path.join(basedir, STATUS_FILE)
  db = sqlite3.connect(status_db)
  mirror_prefix = get_mirror_prefix(db)
  print(">>> " + gcode)
  print("===")
  try:
      print(remote_gcode(mirror_prefix, gcode) + "<<<")
  except Exception as e:
      print("remote error: %s" % e)

def upload_local_changes(basedir):
  print("Uploading local changes:\n")
  basedir = os.path.abspath(basedir)
  os.chdir(basedir)
  status_db = os.path.join(basedir, STATUS_FILE)
  db = sqlite3.connect(status_db)
  mirror_prefix = get_mirror_prefix(db)
  arg = {
    'db': db,
    'basedir': basedir,
    'changes': False,
    'new': [],
    'updated': []
  }
  for (dirent, subdir, files) in os.walk(basedir):
      walk_handler(arg, dirent, files)
  if not arg['changes']:
    print("\tNone\n")
  else:
    # fake request to "authenticate" our IP with RRF
    # setting a password in RRF will break us
    omjson = urllib.request.urlopen(RRF_OBJECT_MODEL % mirror_prefix)
    omjson.close() 
    print()
    for n in arg['new'] + arg['updated']:
      print(".",)
      crc = crc32(basedir, n[0])
      timestamp = time.strftime("%Y-%m-%dT%H:%M:%S",
        time.localtime(os.path.getmtime(n[0])))
      if upload_file(mirror_prefix, n[0], timestamp, crc):
        pathcomp = os.path.split(n[0])
        db.execute(
          "insert or replace into file_info (basedir, name, digest) values (?, ?, ?)",
          (pathcomp[0].replace('\\', '/'), pathcomp[1], n[1]))
      else:
        print("Upload failed", n[0])
    print()

  db.commit()
  db.close()

def do_refresh(basedir):
  basedir = os.path.abspath(basedir)
  os.chdir(basedir)
  status_db = os.path.join(basedir, STATUS_FILE)
  db = sqlite3.connect(status_db)
  mirror_prefix = get_mirror_prefix(db)

  print("Refreshing downloaded configuration from %s\n" % mirror_prefix)

  os.chdir(os.path.join(basedir, "sys"))
  listfiles(db, mirror_prefix, "sys")
  os.chdir(os.path.join(basedir, "macros"))
  listfiles(db, mirror_prefix, "macros")
  os.chdir(os.path.join(basedir, "filaments"))
  listfiles(db, mirror_prefix, "filaments")
  menupath = os.path.join(basedir, "menu")
  if os.path.exists(menupath):
    os.chdir(os.path.join(basedir, "menu"))
    listfiles(db, mirror_prefix, "menu")
  db.commit()
  db.close()
  print()
  check_local_status(basedir)

def listfiles(db, prefix, folder, token = 0):
  fsjson = urllib.request.urlopen(
    RRF_FILELIST % (prefix, token, urllib.parse.quote(folder, safe='')))
  fs = json.load(fsjson)
  fileobjs = fs['files']
  next = fs['next']
  if next != 0:
    listfiles(db, prefix, folder, next)

  updates = []

  local_files = [f[0] for f in list(db.execute(
        "select name from file_info where basedir = ?", (folder,)))]
  remote_files = set([f['name'] for f in fileobjs])
  deleted_files = [f for f in local_files if f not in remote_files]

  for deleted in deleted_files:
    filepath = os.path.join(folder, deleted)
    print("Deleted in RRF, removing", filepath)
    if os.path.isfile(deleted):
      os.remove(deleted)

  for f in fileobjs:
    if f['type'] == 'd':
      if not os.path.exists(f['name']):
        os.makedirs(f['name'])
      os.chdir(f['name'])
      listfiles(db, prefix, "%s/%s" % (folder, f['name']))
      os.chdir("..")
    else:
      filepath = os.path.join(folder, f['name'])

      cur = [row[0] for row in db.execute(
        "select digest from file_info where basedir = ? and name = ?",
        (folder,f['name']))]
      existing_digest = None
      dgst = remote_sha1(prefix, folder + "/" + f['name'])
      overwrite = True
      if len(cur) > 0:
        existing_digest = cur[0]
        current_digest = None
        if os.path.isfile(f['name']):
          current_digest = digest(folder, f['name'])

        if current_digest is not None and current_digest != existing_digest:
          if existing_digest != dgst:
            print("Preserving conflicting local changes in", filepath)
            dgst = existing_digest # retain preserving conflicting message
          overwrite = False
        elif existing_digest != dgst or current_digest is None:
          print("Refreshing", filepath)
          dgst = download_file(prefix, folder, f['name'])

      if os.path.isfile(f['name'] + ".grrtmp"):
        if overwrite:
          if os.path.isfile(f['name']):
            os.remove(f['name'])
          os.rename(f['name'] + ".grrtmp", f['name'])
        else:
          os.remove(f['name'] + ".grrtmp")

      if existing_digest is None:
        print("Downloading", filepath)
        dgst = download_file(prefix, folder, f['name'])
        if os.path.isfile(f['name']):
          os.remove(f['name'])
        os.rename(f['name'] + ".grrtmp", f['name'])

      updates.append((folder, f['name'], dgst))
  db.execute("delete from file_info where basedir = ?", (folder,))
  db.executemany(
    "insert or replace into file_info (basedir, name, digest) values (?, ?, ?)",
    updates)

def download_file(prefix, folder, filename):
  urllib.request.urlretrieve(RRF_DOWNLOAD % (prefix, urllib.parse.quote("%s/%s" % (folder, filename), safe='')), filename + ".grrtmp")
  return digest(folder, filename + ".grrtmp")

def upload_file(prefix, filename, ts, crc):
  headers = {
    "Content-type": "application/json",
    "Content-Length": os.stat(filename).st_size,
  }
  url = RRF_UPLOAD % (
    prefix, urllib.parse.quote("%s" % filename, safe=''), urllib.parse.quote(ts), crc)
  req = urllib.parse.urlparse(url)
  conn = http.client.HTTPConnection(req.hostname)
  conn.request('POST', "%s?%s" % (req.path, req.query), open(filename, "rb"), headers)
  resp = conn.getresponse()
  err = False
  if resp.status != 200:
    print(resp.reason)
  else:
    err = json.load(resp)['err'] != 0
  conn.close()
  return resp.status == 200 and not err

def remote_gcode(prefix, gcode):
  # drain reply buffer
  urllib.request.urlopen(RRF_REPLY % prefix).read()

  prevseq = json.load(urllib.request.urlopen(RRF_SEQS % prefix))['result']
  urllib.request.urlopen(RRF_GCODE % (prefix, urllib.parse.quote(gcode, safe='')), timeout=2).read()
  seq  = json.load(urllib.request.urlopen(RRF_SEQS % prefix))['result']
  count = 0
  # poll fast until seq changes, DWC can potentially empty the buffer
  # 5 second timeout (100 * 50ms)
  while seq == prevseq and count < 100:
    time.sleep(0.050)
    seq = json.load(urllib.request.urlopen(RRF_SEQS % prefix))['result']
    count = count + 1

  if seq == prevseq:
    raise Exception(
      gcode + ": GCode response timed out (%d -> %d)" % (prevseq, seq))
  return urllib.request.urlopen(RRF_REPLY % prefix).read().decode("utf-8")

# this is surprisingly slower than just fetching the files outright  :(
def remote_sha1(prefix, file, depth=0):
  digest = remote_gcode(prefix, RRF_SHA1_FILE % file).strip()
  if len(digest) != 40:
    if depth > 1:
      print(file + ": digest fetch failing [%s], retrying..." % digest)
    return remote_sha1(prefix, file, depth + 1)
  return digest

def crc32(folder, filename):
  # expected as an unsigned value, remove 0x (python3 doesn't have the L)
  with open(filename, "rb") as f:
    return hex(ctypes.c_ulong(zlib.crc32(f.read())).value)[2:]

def digest(folder, filename):
  return _digest(folder, filename, hashlib.sha1())

def _digest(folder, filename, _digest):
  with open(filename, "rb") as f:
    bs = f.read(8192)
    while bs:
      _digest.update(bs)
      bs = f.read(8192)
  return _digest.hexdigest()
  
if __name__ == '__main__':
  main()

