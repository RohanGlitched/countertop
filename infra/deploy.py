"""Build and deploy Countertop to AWS in one command (no Docker, no AWS CLI).

  python infra/deploy.py --dry-run                 # build, package, validate; no AWS calls
  python infra/deploy.py [--stack countertop-web] [--lowtide-mcp URL] [--concurrency N]

Credentials come from the standard boto3 chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN,
or AWS_PROFILE). Everything is created in ap-southeast-2.

Steps: vite build (with the Lowtide sample server's address) → zip api/*.mjs + infra/lambda.mjs → upload to a
deploy bucket → create or update the stack → upload dist/ under site/ in the stack's bucket → invalidate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

# Windows consoles default to a legacy code page, and the smoke test prints arrows and other non-ASCII text:
# without this, a failed print looked like a failed health check and the script retried for minutes.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

INFRA = Path(__file__).resolve().parent
ROOT = INFRA.parent
BUILD = ROOT / "build"
REGION = "ap-southeast-2"


def sh(*cmd, cwd=None, env=None):
    print("$", " ".join(map(str, cmd)), flush=True)
    subprocess.run(list(map(str, cmd)), cwd=cwd, env=env, check=True)


def build_site(lowtide_mcp: str | None):
    env = dict(os.environ)
    if lowtide_mcp:
        env["VITE_LOWTIDE_MCP"] = lowtide_mcp
    sh("npm.cmd" if os.name == "nt" else "npm", "run", "build", cwd=ROOT, env=env)


def package() -> Path:
    BUILD.mkdir(exist_ok=True)
    out = BUILD / "countertop-lambda.zip"
    files = sorted((ROOT / "api").glob("*.mjs")) + [INFRA / "lambda.mjs"]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            info = zipfile.ZipInfo(f.relative_to(ROOT).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, f.read_bytes().replace(b"\r\n", b"\n"))
    print(f"lambda package: {out.stat().st_size / 1e3:.1f} kB, {len(files)} files")
    return out


def site_files():
    dist = ROOT / "dist"
    if not (dist / "index.html").exists():
        raise SystemExit("no dist/index.html: build first")
    out = []
    for f in sorted(dist.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(dist).as_posix()
        ctype = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml"}.get(f.suffix) or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        cache = "public, max-age=31536000, immutable" if rel.startswith("assets/") else "public, max-age=60, must-revalidate"
        out.append((f, "site/" + rel, ctype, cache))
    return out


def check_template():
    try:
        import yaml
    except ImportError:
        print("PyYAML isn't installed: skipping the offline template check (CloudFormation still validates it)")
        return

    class Loader(yaml.SafeLoader):
        pass

    for t in ("Ref", "Sub", "GetAtt", "If", "Not", "Equals", "Select", "Split"):
        Loader.add_constructor(f"!{t}", lambda loader, node: loader.construct_scalar(node) if isinstance(node, yaml.ScalarNode) else loader.construct_sequence(node, deep=True))
    t = yaml.load((INFRA / "template.yaml").read_text(encoding="utf8"), Loader=Loader)
    for must in ("Fn", "FnUrl", "Cdn", "Bucket", "BucketPolicy", "FnRole", "ForwardHostFn"):
        assert must in t["Resources"], must
    print(f"template ok: {len(t['Resources'])} resources")


def stack_outputs(cf, stack):
    from botocore.exceptions import ClientError
    try:
        s = cf.describe_stacks(StackName=stack)["Stacks"][0]
    except ClientError:
        return None
    return None if s["StackStatus"] in ("ROLLBACK_COMPLETE", "DELETE_COMPLETE") else {o["OutputKey"]: o["OutputValue"] for o in s.get("Outputs", [])}


def deploy_stack(cf, stack, params):
    from botocore.exceptions import ClientError
    body = (INFRA / "template.yaml").read_text(encoding="utf8")
    p = [{"ParameterKey": k, "ParameterValue": str(v)} for k, v in params.items()]
    try:
        s = cf.describe_stacks(StackName=stack)["Stacks"][0]
        if s["StackStatus"] == "ROLLBACK_COMPLETE":
            cf.delete_stack(StackName=stack)
            cf.get_waiter("stack_delete_complete").wait(StackName=stack)
            exists = False
        else:
            exists = True
    except ClientError:
        exists = False
    try:
        if exists:
            cf.update_stack(StackName=stack, TemplateBody=body, Parameters=p, Capabilities=["CAPABILITY_IAM"])
            waiter = cf.get_waiter("stack_update_complete")
        else:
            cf.create_stack(StackName=stack, TemplateBody=body, Parameters=p, Capabilities=["CAPABILITY_IAM"], OnFailure="ROLLBACK", Tags=[{"Key": "project", "Value": "countertop"}])
            waiter = cf.get_waiter("stack_create_complete")
    except ClientError as e:
        if "No updates are to be performed" in str(e):
            print("stack unchanged")
            return
        raise
    print(f"waiting for {stack} (CloudFront takes 5-15 minutes on the first deploy)…", flush=True)
    try:
        waiter.wait(StackName=stack, WaiterConfig={"Delay": 15, "MaxAttempts": 160})
    except Exception:
        for ev in cf.describe_stack_events(StackName=stack)["StackEvents"][:40]:
            if "FAILED" in ev["ResourceStatus"]:
                print(f"  {ev['LogicalResourceId']}: {ev['ResourceStatus']} {ev.get('ResourceStatusReason', '')}")
        raise


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stack", default="countertop-web")
    ap.add_argument("--region", default=REGION)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--lowtide-mcp", help="the sample server's MCP URL (default: the lowtide-web stack's, else Vercel)")
    ap.add_argument("--concurrency", type=int, default=10, help="reserved concurrency for the model function (the account allows 400; 100 must stay unreserved)")
    a = ap.parse_args()
    if a.region != REGION:
        raise SystemExit(f"the organisation allows only {REGION}")
    check_template()

    if a.dry_run:
        if not a.skip_build:
            build_site(a.lowtide_mcp)
        z = package()
        print(json.dumps({"dry_run": True, "zip": str(z), "zip_kb": round(z.stat().st_size / 1e3, 1), "site_files": len(site_files())}, indent=1))
        return

    import boto3
    from botocore.exceptions import ClientError

    sess = boto3.Session(region_name=a.region)
    account = sess.client("sts").get_caller_identity()["Account"]
    s3, cf = sess.client("s3"), sess.client("cloudformation")
    lowtide = a.lowtide_mcp or ((stack_outputs(cf, "lowtide-web") or {}).get("McpUrl"))
    if not a.skip_build:
        build_site(lowtide)
    z = package()
    code_bucket = f"{a.stack}-deploy-{account}-{a.region}"
    try:
        s3.head_bucket(Bucket=code_bucket)
    except ClientError:
        s3.create_bucket(Bucket=code_bucket, CreateBucketConfiguration={"LocationConstraint": a.region})
        s3.put_public_access_block(Bucket=code_bucket, PublicAccessBlockConfiguration={k: True for k in ("BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets")})
    key = f"lambda/countertop-{hashlib.sha256(z.read_bytes()).hexdigest()[:16]}.zip"
    s3.upload_file(str(z), code_bucket, key)
    deploy_stack(cf, a.stack, {"CodeBucket": code_bucket, "CodeKey": key, "MaxConcurrency": a.concurrency})
    out = stack_outputs(cf, a.stack)
    files = site_files()
    # hashed assets first, index.html last, so a visitor never gets a page whose assets aren't there yet
    for f, k, ctype, cache in sorted(files, key=lambda x: x[1].endswith("index.html")):
        s3.upload_file(str(f), out["Bucket"], k, ExtraArgs={"ContentType": ctype, "CacheControl": cache})
    print(f"uploaded {len(files)} site files")
    sess.client("cloudfront").create_invalidation(DistributionId=out["DistributionId"], InvalidationBatch={"Paths": {"Quantity": 1, "Items": ["/*"]}, "CallerReference": str(time.time())})
    print(json.dumps(out, indent=1))
    try:
        with urllib.request.urlopen(out["SiteUrl"] + "/api/turn", timeout=30) as r:
            print("GET /api/turn →", r.status, r.read()[:200])
    except Exception as e:
        print("GET /api/turn not answering yet:", e)
    print("\nlive at", out["SiteUrl"])


if __name__ == "__main__":
    sys.exit(main())
