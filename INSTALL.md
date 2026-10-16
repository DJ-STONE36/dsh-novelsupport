# 安装 dsh-novelsupport

这是一个 DeepSeek Harness 插件包（dsh-novelsupport-0.1.0.tgz，dsh-novelsupport@0.1.0）。

## 一、装到某个 profile 里

DSH 的插件放在 profile 的 `node_modules` 下。把包解开，让
`<profile>/node_modules/dsh-novelsupport/` 里直接就是 `package.json`：

```powershell
# 1) 解开（把 <profile> 换成你的，例如 D:\dsh-home\profiles\desktop）
tar -xzf dsh-novelsupport-0.1.0.tgz -C <profile>\node_modules
Rename-Item <profile>\node_modules\package <profile>\node_modules\dsh-novelsupport
```

包里的路径以 `package/` 开头，所以解开后需要改名一次；这是 tar 的常规形状。
**目录名必须是包名 `dsh-novelsupport`**：宿主按包名解析这一行，改成别的名字它就找不到。
（插件 id 仍是 `dsh-novel`，路由前缀与写头都用它，与目录名无关。）

## 二、装依赖

宿主半依赖 **js-yaml**（读写章节的 YAML front matter）。profile 里已经有它就不用管；
没有的话在 profile 目录执行：

```powershell
pnpm add js-yaml      # 或 npm i js-yaml
```

客户端半只依赖 `react`，由 DSH 的模块加载器提供，不需要单独安装。

## 三、重启 DSH

插件在启动时注册，重启后 `/dsh-novel/health` 应该返回 `{"ok":true}`：

```powershell
curl http://127.0.0.1:19387/dsh-novel/health
```

界面里会出现侧栏入口「小说」。**注意**：写作 / 校验 / 文风三个技能位于**工作区的**
`.dsh/skills/` 下，不在这个包里——插件负责界面与数据，技能负责写作，两者要一起才有完整功能。

## 四、插件做了什么

- 三栏界面：项目 → 分支（世界 / 时间轴 / 组织 / 人物 / 物品 / 剧情大纲 / 章节）
- 地图：手绘与导入底图、笔迹 / 河流 / 道路 / 边界 / 山脉、标记点、文字、图章、喷漆
- 时间轴：多条时间线、可编辑起止、事件、剧情大纲
- 导出全书为一份 Markdown（写进 `novel/export/`，并给出完整路径）
- 纯文本批量导入人物 / 地点 / 物品，可带基础信息
- 交给 agent 写某一章（需要宿主已打上 `prompt(request, signal)` 的可选参数补丁）

细节见包里的 `README.md`。
