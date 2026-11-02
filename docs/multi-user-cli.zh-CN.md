# Paseo-mod 多用户命令行使用说明

适用于当前 fork 的密码空间功能：一台 Mac mini 运行一个 daemon，所有人连接同一个地址和端口，通过不同密码进入各自的项目和聊天空间。同一密码可以在多台设备上使用，进入的是同一个空间。

安装、升级见 [FORK.md](../FORK.md)。本文中的管理命令都在 **Mac mini 上，以运行 daemon 的 macOS 用户执行**；通过 SSH 登录 Mac mini 后也可以操作。无需为每个人建立 macOS 账户。

## 1. 确认版本和数据目录

```sh
paseo --version
paseo daemon users --help
paseo daemon status
```

版本应包含 `-mod`，帮助中应有 `set`、`list`、`remove`。如果找不到 `users`，用 `command -v paseo` 检查当前终端调用的是哪个安装位置。

默认数据目录是 `~/.paseo`，日常命令无需传 `--home`。如果设置了 `PASEO_HOME`，则使用该环境变量指定的目录；管理自定义实例时，可以显式加 `--home /实际目录`。

自定义 `--home` 应指向整个 daemon 的数据目录，不要指向 `users/zhangsan` 子目录。`users` 是本地配置命令，不支持用 `--host` 管理远程用户。

## 2. 准备每个人的项目根目录

根目录必须已经存在。它是用户搜索和添加项目的范围，不会自动把里面的每个文件夹注册成项目。

使用本地目录时，可以先创建：

```sh
mkdir -p "$HOME/Documents/团队项目/张三"
mkdir -p "$HOME/Documents/团队项目/李四"
```

使用已经挂载在 Mac mini 上的 SMB 目录时，先确认路径可读：

```sh
ls -ld "/Volumes/团队共享/张三"
ls -ld "$HOME/Documents/xxx/李四"
```

这两个位置都受支持。路径属于 Mac mini，不能填写远程客户端电脑上的路径。SMB 断开时先恢复挂载，再配置或搜索项目；不要用 `mkdir -p` 代替恢复挂载。

路径有中文或空格时，用双引号包起来。主目录推荐写成 `"$HOME/Documents/..."`。

## 3. 创建用户

例如为张三创建 ID 为 `zhangsan` 的空间：

```sh
paseo daemon users set zhangsan \
  --root "/Volumes/团队共享/张三"
```

再为李四创建一个空间：

```sh
paseo daemon users set lisi \
  --root "$HOME/Documents/xxx/李四"
```

每条命令都会要求输入两次密码，输入不回显。请在交互式终端执行，不能通过管道或密码命令行参数创建用户。

| 参数               | 用法                                              |
| ------------------ | ------------------------------------------------- |
| `zhangsan`         | 空间的固定 ID，也是用户数据目录名；创建后保持不变 |
| `--name "张三"`    | 可选的管理显示名，不是登录用户名                  |
| `--root <路径...>` | 必填；一次提交该用户完整的项目根目录列表          |
| `--home <目录>`    | daemon 数据目录                                   |

用户 ID 长度为 1–64 个字符，只能使用英文字母、数字、下划线、短横线，并且以字母或数字开头。中文姓名放在 `--name` 中。

每个人的密码必须与其他用户、已有 owner 密码不同。密码要求为 1–72 个 UTF-8 字节；中文字符会占用多个字节。配置文件只保存 bcrypt 哈希，不能查看原密码，忘记后需要重设。

需要多个根目录时，在一个 `--root` 后写多个路径：

```sh
paseo daemon users set zhangsan \
  --root "/Volumes/团队共享/张三" "$HOME/Documents/张三的本地项目"
```

第一个根目录还用于存放该空间的托管 worktree：`.paseo-worktrees/zhangsan/`。需要该功能时，确保第一个根目录可写。

## 4. 查看配置，让变更生效

```sh
paseo daemon users list
```

输出是 JSON，包含用户的 `id`、可选 `name` 和 `projectRoots`，不显示密码哈希。它读取磁盘配置，即使 daemon 没有运行也可使用；列表更新不代表运行中的 daemon 已加载变更。

**创建、修改、删除用户后，均需重启 daemon。** 可以一次配置多个人，再统一重启。`users` 命令不会自动重启，`paseo reload` 不能替代这里的重启。

先安排所有人结束或暂停当前 Agent 任务；重启会让所有客户端短暂断开，并关闭当前 Agent 执行进程，已保存的聊天记录保留。对于用 CLI 启动的 daemon，执行：

```sh
paseo daemon restart
paseo daemon status
```

如果尚未启动，执行：

```sh
paseo daemon start
```

如果通过其他服务管理器或前台 `paseo daemon run` 运行，使用原来的部署方式停止、启动。安装的 fork daemon 与 Paseo Desktop 内置的本机 daemon 是不同部署，客户端应连接到 fork 所在的地址。

首次开放局域网连接时，如果监听地址仍然只允许本机，可以配置：

```sh
paseo daemon config set daemon.listen '0.0.0.0:6767'
```

然后按上面的步骤重启。`0.0.0.0` 是监听地址；客户端填写 Mac mini 实际的局域网或 VPN 地址，例如 `192.168.1.20:6767`。

## 5. 让用户连接并添加项目

每个人在现有 Paseo 客户端中添加同一个 Mac mini 地址，填写各自密码。无需填写用户 ID 或姓名。多台设备使用张三的密码，就会看到张三的同一套项目和聊天。

在 Add Project 的目录搜索框里，输入 `.` 可以先列出配置根目录及直接子目录，也可以输入项目中文名或相对路径前缀。完整搜索用法见 [FORK.md 的项目搜索说明](../FORK.md#find-projects-without-typing-absolute-paths)。

添加项目后，直接在 Paseo 中新建 Chat 并选择 Claude Code。密码空间不提供外部终端历史的发现和导入。

需要在命令行验证某个人的项目列表时，必须显式连接地址并提供该人的密码。下面示例用于 macOS 默认 zsh，密码不会写进命令历史：

```zsh
read -rs "paseo_space_password?请输入该用户的连接密码: "
print
PASEO_PASSWORD="$paseo_space_password" paseo --host 127.0.0.1:6767 project ls
unset paseo_space_password
```

在其他电脑上执行时，将 `127.0.0.1` 换成 Mac mini 的实际地址，并在那台电脑上安装 CLI。

需要通过 CLI 注册一个已存在的项目目录时，可以在清除密码变量之前执行：

```zsh
PASEO_PASSWORD="$paseo_space_password" paseo --host 127.0.0.1:6767 \
  project create "/Volumes/团队共享/张三/订单系统"
```

显式连接远程 daemon 时，填写 daemon 上的绝对路径。短名称搜索和相对前缀补全属于客户端目录搜索框的功能，`project create` 不会替你搜索路径。

不带用户密码、通过本地 `--home` 连接的 CLI 使用原有 owner 空间。不要用 owner 的项目列表判断其他用户的空间是否为空。

## 6. 修改密码、目录和姓名

这些操作都使用 `users set`，没有单独的 `passwd` 或 `add-root` 命令。

例如给张三更换密码，同时保留原目录：

```sh
paseo daemon users set zhangsan \
  --root "/Volumes/团队共享/张三"
```

按提示输入两遍新密码，再重启 daemon。客户端随后改用新密码；相同用户 ID 的项目、聊天和空间身份保留。

只想调整目录时，也要按提示输入两遍密码；可以输入当前密码。**每次 `set` 都覆盖该 ID 的整条用户配置：**

- 保留原来的用户 ID，才能继续使用原数据。
- 传入所有仍需保留的根目录；省略的旧根目录会从配置中移除。
- 要保留姓名就继续传 `--name`；省略会清除已配置的姓名。
- 调整根目录不会迁移磁盘文件，也不会自动清理已有项目和聊天。

目录缩小后，旧聊天仍可能引用旧的工作目录。迁移项目时，先安排停止相关任务、移动项目文件，再调整配置和项目登记，不能只改 `--root`。

没有用户 ID 重命名命令。用新 ID 执行 `set` 会创建另一个空间。

`--name` 是可选显示名，不参与登录。只用 `zhangsan` 就能完整管理空间。如果确实要在列表中显示中文姓名，执行：

```sh
paseo daemon users set zhangsan --name "张三" --root "/Volumes/团队共享/张三"
```

## 7. 停用、恢复用户

停用李四：

```sh
paseo daemon users remove lisi
paseo daemon users list
```

重启后，原密码不能再进入李四的空间。重启前，运行中的配置和已有连接仍可能继续有效。该操作不删除 `~/.paseo/users/lisi/`，也不删除李四的项目源文件。

恢复同一空间时，使用原 ID 重新配置：

```sh
paseo daemon users set lisi \
  --root "$HOME/Documents/xxx/李四"
```

设置密码并重启后，只要原数据目录仍在，就能继续使用原空间。

原有 owner 空间不属于 `users list` 中的用户，不能通过 `users remove` 删除。删除最后一个密码空间后，daemon 在重启后恢复仅使用原有 owner 空间的模式。

## 8. 备份和恢复

默认数据分布如下：

| 位置                               | 内容                                                |
| ---------------------------------- | --------------------------------------------------- |
| `~/.paseo/config.json`             | 所有用户的 ID、根目录、姓名和密码哈希等 daemon 配置 |
| `~/.paseo/users/<id>/`             | 对应空间的项目登记、工作区、聊天记录等 Paseo 数据   |
| 原有 `~/.paseo/` 根级数据          | owner 空间和 daemon 共用数据                        |
| 配置的项目根目录                   | 实际源代码，以及根目录下创建的托管 worktree         |
| macOS 用户的 Claude 配置和历史目录 | Claude 自己的数据；不包含在 Paseo 备份中            |

维护前，先在约定的停机时间结束 Agent 任务、停止 daemon，再备份，以获得一致的数据副本。CLI 管理的部署可以执行：

```sh
paseo daemon stop
mkdir -p "$HOME/paseo-backups"
paseo_backup_dir="$HOME/paseo-backups/paseo-$(date +%Y%m%d-%H%M%S)"
cp -a "$HOME/.paseo" "$paseo_backup_dir"
printf '备份目录：%s\n' "$paseo_backup_dir"
paseo daemon start
```

这只备份 Paseo 数据。项目源文件和 Claude 自己的数据需要另外备份。若希望保留原有客户端空间识别，备份时应保留整个用户目录及其中的 `server-id`，不要只复制 `agents`。

恢复时停止 daemon，先把当前数据目录移到另一个备份位置，再将所需备份完整复制回原 `--home` 路径，核对项目挂载路径后启动。不要把不同时间的 `config.json` 和用户目录随意混合，也不要在 daemon 运行时覆盖文件。

CLI 没有永久删除用户数据的命令。需要清理空间时，先 `remove` 并重启让停用生效，再于停机维护时备份、归档对应的 `users/<id>/`。不要为了停用用户删除项目源目录或整个 `~/.paseo`。

## 9. 常见问题

`0.14.0-mod.7` 的 `daemon restart` 可能在本地凭证轮换期间误报 `Password required`。如果稍后 `paseo daemon status` 显示 `connectedDaemon: reachable`，先确认服务已恢复，再升级到包含重连修复的版本。这个问题不需要通过重设用户密码解决。

| 现象                           | 处理                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `users set` 提示需要交互式终端 | 在 Mac mini 本机终端运行；SSH 时使用交互式会话，必要时用 `ssh -t` 分配终端                          |
| 提示密码属于其他用户或 owner   | 换一个不同的密码；密码就是空间选择依据                                                              |
| `Not a directory` 或路径不存在 | 检查路径是否位于 Mac mini、SMB 是否已挂载、当前 macOS 用户是否可读                                  |
| 配置已更新，但新密码无效       | 确认配置的 `--home` 与运行实例一致，并已重启该实例                                                  |
| 两个人看到同一套项目和聊天     | 检查客户端是否保存了同一个密码，是否都连接了 owner 空间                                             |
| 搜索不到刚挂载的目录           | 先在 Mac mini 用 `ls` 验证；等待约五秒目录缓存过期，再输入 `.` 或更具体的前缀；必要时缩小根目录范围 |
| 提示项目位于根目录之外         | 将项目加入该用户完整的 `--root` 列表，或在已配置根目录内选择项目；符号链接还会检查实际目标路径      |
| 修改后列表里出现另一个空用户   | 检查是否把原 ID 改成了新 ID；姓名可以改，ID 应保持不变                                              |

诊断时先看 `paseo daemon status`。默认 daemon 日志在 `~/.paseo/daemon.log`；配置了自定义日志位置时使用实际位置。状态请求超时不代表必须重启。

## 10. 命令速查

| 目的               | 命令                                           |
| ------------------ | ---------------------------------------------- |
| 创建或修改用户     | `paseo daemon users set <id> --root <路径...>` |
| 查看用户配置       | `paseo daemon users list`                      |
| 停用用户，保留数据 | `paseo daemon users remove <id>`               |
| 加载用户配置变更   | `paseo daemon restart`                         |
| 首次启动           | `paseo daemon start`                           |
| 查看运行状态       | `paseo daemon status`                          |
| 停止服务以便维护   | `paseo daemon stop`                            |

`set`、`remove` 先修改磁盘配置，再由管理员安排重启。目录范围用于项目组织和选择，不构成 Agent 或终端命令的操作系统文件隔离。
