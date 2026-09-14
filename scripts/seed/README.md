# 本地演示数据

这里的脚本只往 Postgres 写入演示行，不改产品代码、不在前端/后端硬编码业务数据。

## 代码本体平台

```bash
# 在仓库根目录，使用当前 .env 的 DATABASE_URL
python3 scripts/seed/seed_ontology_platform_demo.py
```

可重复执行：同一 `scan_id` / `metadata.seed` 的旧演示行会先清再灌。只写 Postgres（以及该项目已绑定的档案目录里的演示文稿），不改前端 / 后端业务代码。
