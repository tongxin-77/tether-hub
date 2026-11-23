; Tether Hub Windows 安装程序（Inno Setup 6.5+）。由 scripts/package.ts 调用 ISCC 编译，传入：
;   /DAppVersion=<版本> /DPayloadDir=<组装好的应用目录> /DWinSW=<WinSW-x64.exe> /DZhIsl=<ChineseSimplified.isl>
;   /DTwIsl=<ChineseTraditional.isl>（两个非官方语言文件由 package.ts 下载并校验；英文、日文用 Inno 自带的）
;   /DOutputDir=<输出目录> /DOutputBaseFilename=<文件名>
;
; 应用文件装到 {app}（默认 Program Files\tether-hub）；配置与数据在 %ProgramData%\tether-hub（仅 SYSTEM 与
; Administrators 可访问）：config.env（服务环境变量，含管理员密码）、data\（HUB_DATA_DIR）、logs\（服务日志）。
; 服务 tether-hub 由 WinSW 运行 node.exe --env-file=config.env dist\main.js，开机自启，异常退出 5 秒后重启。
;
; 静默安装：/VERYSILENT /SUPPRESSMSGBOXES /PASSWORD=<管理员密码> [/PORT=8443] (/CERT=<证书> /KEY=<私钥> | /INSECURE=1)
; 升级（config.env 已存在）：不显示配置页、不需要参数，保留配置，只替换应用文件并重启服务。
; 卸载：删除服务与防火墙规则；交互卸载时询问是否删除 %ProgramData%\tether-hub，静默卸载保留。

#ifndef AppVersion
  #error 需要 /DAppVersion 等参数，请用 pnpm package 编译
#endif

#define AppName "Tether Hub"
#define FwRule "Tether Hub"

[Setup]
AppId={{8C4B1E3A-6F2D-4C7B-9E51-3A7D2B9F0C64}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=tongxin-77
AppPublisherURL=https://github.com/tongxin-77/tether-hub
DefaultDirName={autopf}\tether-hub
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
UninstallDisplayName={#AppName}
; 按 Windows 界面语言选择安装器语言（精确匹配，其次同主语言，如 zh-SG / zh-HK 取 [Languages] 中靠前的简体；都不匹配用第一个即英文），不显示语言选择框
LanguageDetectionMethod=uilanguage
ShowLanguageDialog=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "zh"; MessagesFile: "{#ZhIsl}"
Name: "zhtw"; MessagesFile: "{#TwIsl}"
Name: "ja"; MessagesFile: "compiler:Languages\Japanese.isl"

[CustomMessages]
; 界面文字：zh 简体（源语言）、en、zhtw 繁体、ja 日文；按 Windows 界面语言自动选择，不显示语言选择框
zh.OpenWeb=打开管理网页
en.OpenWeb=Open admin page
zhtw.OpenWeb=開啟管理網頁
ja.OpenWeb=管理ページを開く
zh.TokenCli=Token 命令行
en.TokenCli=Token command line
zhtw.TokenCli=Token 命令列
ja.TokenCli=Token コマンドライン
zh.UninstallApp=卸载 %1
en.UninstallApp=Uninstall %1
zhtw.UninstallApp=解除安裝 %1
ja.UninstallApp=%1 のアンインストール
zh.SvcDesc=Tether 自托管管理服务器
en.SvcDesc=Tether self-hosted management server
zhtw.SvcDesc=Tether 自架管理伺服器
ja.SvcDesc=Tether セルフホスト管理サーバー
zh.ErrNoPwd=请设置管理员密码
en.ErrNoPwd=Please set the admin password
zhtw.ErrNoPwd=請設定管理員密碼
ja.ErrNoPwd=管理者パスワードを設定してください
zh.ErrPwdMismatch=两次输入的密码不一致
en.ErrPwdMismatch=The passwords do not match
zhtw.ErrPwdMismatch=兩次輸入的密碼不一致
ja.ErrPwdMismatch=入力したパスワードが一致しません
zh.ErrPwdQuotes=密码不能同时包含单引号、反引号与双引号
en.ErrPwdQuotes=The password cannot contain single quotes, backticks and double quotes all at once
zhtw.ErrPwdQuotes=密碼不能同時包含單引號、反引號與雙引號
ja.ErrPwdQuotes=パスワードにシングルクォート、バッククォート、ダブルクォートをすべて含めることはできません
zh.ErrPort=端口应为 1–65535 的整数
en.ErrPort=The port must be an integer from 1 to 65535
zhtw.ErrPort=連接埠應為 1–65535 的整數
ja.ErrPort=ポートは 1～65535 の整数で指定してください
zh.ErrNoCert=请选择证书与私钥文件
en.ErrNoCert=Please choose the certificate and private key files
zhtw.ErrNoCert=請選擇憑證與私鑰檔案
ja.ErrNoCert=証明書と秘密鍵のファイルを選択してください
zh.ErrCertMissing=证书文件不存在：%1
en.ErrCertMissing=Certificate file not found: %1
zhtw.ErrCertMissing=憑證檔案不存在：%1
ja.ErrCertMissing=証明書ファイルが見つかりません：%1
zh.ErrKeyMissing=私钥文件不存在：%1
en.ErrKeyMissing=Private key file not found: %1
zhtw.ErrKeyMissing=私鑰檔案不存在：%1
ja.ErrKeyMissing=秘密鍵ファイルが見つかりません：%1
zh.ErrCertChars=证书路径包含无法写入配置的字符
en.ErrCertChars=The certificate path contains characters that cannot be written to the config
zhtw.ErrCertChars=憑證路徑包含無法寫入設定的字元
ja.ErrCertChars=証明書のパスに設定へ書き込めない文字が含まれています
zh.SilentNeedCert=（静默安装需提供 /CERT 与 /KEY，或 /INSECURE=1）
en.SilentNeedCert=; silent install requires /CERT and /KEY, or /INSECURE=1
zhtw.SilentNeedCert=（靜默安裝需提供 /CERT 與 /KEY，或 /INSECURE=1）
ja.SilentNeedCert=（サイレントインストールには /CERT と /KEY、または /INSECURE=1 が必要です）
zh.SilentBadParams=静默安装参数错误：%1
en.SilentBadParams=Invalid silent install parameters: %1
zhtw.SilentBadParams=靜默安裝參數錯誤：%1
ja.SilentBadParams=サイレントインストールのパラメーターが不正です：%1
zh.CfgTitle=管理员与端口
en.CfgTitle=Admin and port
zhtw.CfgTitle=管理員與連接埠
ja.CfgTitle=管理者とポート
zh.CfgDesc=设置网页管理员密码与监听端口
en.CfgDesc=Set the web admin password and the listening port
zhtw.CfgDesc=設定網頁管理員密碼與監聽連接埠
ja.CfgDesc=Web 管理者パスワードと待ち受けポートを設定します
zh.CfgSub=端口同时用于管理网页与各机器 Tether 的连接，安装时会为它添加防火墙入站规则。
en.CfgSub=The port serves both the admin page and Tether connections from your machines. An inbound firewall rule is added for it during installation.
zhtw.CfgSub=連接埠同時用於管理網頁與各機器 Tether 的連線，安裝時會為它新增防火牆輸入規則。
ja.CfgSub=このポートは管理ページと各マシンの Tether からの接続の両方に使われます。インストール時に受信のファイアウォール規則を追加します。
zh.CfgPwd=管理员密码：
en.CfgPwd=Admin password:
zhtw.CfgPwd=管理員密碼：
ja.CfgPwd=管理者パスワード：
zh.CfgConfirm=确认密码：
en.CfgConfirm=Confirm password:
zhtw.CfgConfirm=確認密碼：
ja.CfgConfirm=パスワードの確認：
zh.CfgPort=端口：
en.CfgPort=Port:
zhtw.CfgPort=連接埠：
ja.CfgPort=ポート：
zh.TlsTitle=传输加密
en.TlsTitle=Transport encryption
zhtw.TlsTitle=傳輸加密
ja.TlsTitle=通信の暗号化
zh.TlsDesc=选择 hub 的连接方式
en.TlsDesc=Choose how the hub accepts connections
zhtw.TlsDesc=選擇 hub 的連線方式
ja.TlsDesc=hub の接続方式を選択します
zh.TlsSub=推荐使用 TLS 证书（https / wss）。没有证书时可选明文，但 token 与管理员密码会以明文传输。
en.TlsSub=A TLS certificate (https / wss) is recommended. Without one you can choose plaintext, but tokens and the admin password are then sent unencrypted.
zhtw.TlsSub=建議使用 TLS 憑證（https / wss）。沒有憑證時可選明文，但 token 與管理員密碼會以明文傳輸。
ja.TlsSub=TLS 証明書（https / wss）の使用を推奨します。証明書がない場合は平文を選べますが、token と管理者パスワードが暗号化されずに送信されます。
zh.TlsOptCert=使用 TLS 证书（推荐）
en.TlsOptCert=Use a TLS certificate (recommended)
zhtw.TlsOptCert=使用 TLS 憑證（建議）
ja.TlsOptCert=TLS 証明書を使用する（推奨）
zh.TlsOptPlain=不使用证书，明文 HTTP / ws（HUB_INSECURE=1，仅限本机或可信局域网）
en.TlsOptPlain=No certificate, plaintext HTTP / ws (HUB_INSECURE=1, local machine or trusted LAN only)
zhtw.TlsOptPlain=不使用憑證，明文 HTTP / ws（HUB_INSECURE=1，僅限本機或可信任區域網路）
ja.TlsOptPlain=証明書なし、平文の HTTP / ws（HUB_INSECURE=1、このマシンまたは信頼できる LAN のみ）
zh.CertTitle=TLS 证书
en.CertTitle=TLS certificate
zhtw.CertTitle=TLS 憑證
ja.CertTitle=TLS 証明書
zh.CertDesc=选择 PEM 格式的证书与私钥
en.CertDesc=Choose the certificate and private key in PEM format
zhtw.CertDesc=選擇 PEM 格式的憑證與私鑰
ja.CertDesc=PEM 形式の証明書と秘密鍵を選択します
zh.CertSub=服务直接读取这两个文件，请放在不会被移动或删除的位置（例如 %1）。
en.CertSub=The service reads these two files directly, so keep them where they will not be moved or deleted (for example %1).
zhtw.CertSub=服務直接讀取這兩個檔案，請放在不會被移動或刪除的位置（例如 %1）。
ja.CertSub=サービスはこの 2 つのファイルを直接読み込むため、移動や削除されない場所（例：%1）に置いてください。
zh.CertCert=证书：
en.CertCert=Certificate:
zhtw.CertCert=憑證：
ja.CertCert=証明書：
zh.CertKey=私钥：
en.CertKey=Private key:
zhtw.CertKey=私鑰：
ja.CertKey=秘密鍵：
zh.PemFiles=PEM 文件
en.PemFiles=PEM files
zhtw.PemFiles=PEM 檔案
ja.PemFiles=PEM ファイル
zh.AllFiles=所有文件
en.AllFiles=All files
zhtw.AllFiles=所有檔案
ja.AllFiles=すべてのファイル
zh.PlainWarn1=明文模式下，管理网页与各机器的连接都不加密，token 与管理员密码可被同一网络中的人窃听。
en.PlainWarn1=In plaintext mode neither the admin page nor the machine connections are encrypted; anyone on the same network can eavesdrop on tokens and the admin password.
zhtw.PlainWarn1=明文模式下，管理網頁與各機器的連線都不加密，token 與管理員密碼可被同一網路中的人竊聽。
ja.PlainWarn1=平文モードでは管理ページと各マシンの接続はいずれも暗号化されず、同じネットワーク上の誰かに token と管理者パスワードを盗聴される可能性があります。
zh.PlainWarn2=仅建议在本机或可信局域网中使用。确定继续？
en.PlainWarn2=Recommended only on this machine or a trusted LAN. Continue?
zhtw.PlainWarn2=僅建議在本機或可信任區域網路中使用。確定繼續？
ja.PlainWarn2=このマシンまたは信頼できる LAN でのみ使用してください。続行しますか？
zh.ErrWriteFile=写入 %1 失败
en.ErrWriteFile=Failed to write %1
zhtw.ErrWriteFile=寫入 %1 失敗
ja.ErrWriteFile=%1 の書き込みに失敗しました
zh.ErrSvcInstall=注册服务失败，详见安装日志
en.ErrSvcInstall=Failed to register the service; see the setup log for details
zhtw.ErrSvcInstall=註冊服務失敗，詳見安裝記錄
ja.ErrSvcInstall=サービスの登録に失敗しました。詳細はセットアップログを参照してください
zh.ErrSvcStart=服务启动失败，请查看 %1 中的日志
en.ErrSvcStart=The service failed to start; check the logs in %1
zhtw.ErrSvcStart=服務啟動失敗，請查看 %1 中的記錄
ja.ErrSvcStart=サービスを開始できませんでした。%1 のログを確認してください
zh.DelData1=是否同时删除配置与数据？
en.DelData1=Also delete the configuration and data?
zhtw.DelData1=是否同時刪除設定與資料？
ja.DelData1=設定とデータも削除しますか？
zh.DelData2=其中包括管理员密码、机器 token 与审计日志；保留则重新安装后可继续使用。
en.DelData2=This includes the admin password, machine tokens and the audit log. Keep them to continue using them after reinstalling.
zhtw.DelData2=其中包括管理員密碼、機器 token 與稽核日誌；保留則重新安裝後可繼續使用。
ja.DelData2=管理者パスワード、マシン token、監査ログが含まれます。残しておくと再インストール後も引き続き使用できます。

[InstallDelete]
; 升级时先清掉旧版本的应用目录，避免残留已删除的文件（含网页一键更新留下的 .update）
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\.update"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WinSW}"; DestDir: "{app}"; DestName: "tether-hub-service.exe"; Flags: ignoreversion

[Icons]
Name: "{group}\{cm:OpenWeb}"; Filename: "{code:WebUrl}"
Name: "{group}\{cm:TokenCli}"; Filename: "{cmd}"; Parameters: "/k ""{app}\tether-hub-token.cmd"""; WorkingDir: "{app}"
Name: "{group}\{cm:UninstallApp,{#AppName}}"; Filename: "{uninstallexe}"

[UninstallRun]
Filename: "{app}\tether-hub-service.exe"; Parameters: "stopwait"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{app}\tether-hub-service.exe"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "DeleteService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#FwRule}"""; Flags: runhidden; RunOnceId: "DeleteFirewallRule"

[UninstallDelete]
; 网页一键更新换入的文件不在安装记录里，按目录删除
Type: filesandordirs; Name: "{app}\dist"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\.update"
Type: files; Name: "{app}\tether-hub-service.xml"

[Code]
var
  CfgPage: TInputQueryWizardPage;
  TlsPage: TInputOptionWizardPage;
  CertPage: TInputFileWizardPage;
  { config.env 已存在：升级安装，保留配置 }
  Upgrade: Boolean;

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\tether-hub');
end;

function CfgFile: String;
begin
  Result := DataDir + '\config.env';
end;

function ServiceExe: String;
begin
  Result := ExpandConstant('{app}\tether-hub-service.exe');
end;

{ 按 Node --env-file 的规则加引号：单引号 / 反引号内原样保留；双引号内会展开 \n，故最后才用 }
function EnvQuote(const S: String): String;
begin
  if Pos('''', S) = 0 then Result := '''' + S + ''''
  else if Pos('`', S) = 0 then Result := '`' + S + '`'
  else if (Pos('"', S) = 0) and (Pos('\n', S) = 0) then Result := '"' + S + '"'
  else Result := '';
end;

{ 读取 config.env 中的值（去掉引号），不存在时为空 }
function CfgValue(const Key: String): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if not LoadStringsFromFile(CfgFile, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
    if Pos(Key + '=', Lines[I]) = 1 then
    begin
      Result := Trim(Copy(Lines[I], Length(Key) + 2, MaxInt));
      if (Length(Result) >= 2) and (Pos(Copy(Result, 1, 1), '''"`') > 0) then
        Result := Copy(Result, 2, Length(Result) - 2);
    end;
end;

function Insecure: Boolean;
begin
  if Upgrade then Result := CfgValue('HUB_INSECURE') = '1'
  else Result := TlsPage.SelectedValueIndex = 1;
end;

function Port: String;
begin
  if Upgrade then Result := CfgValue('HUB_PORT') else Result := Trim(CfgPage.Values[2]);
  if Result = '' then Result := '8443';
end;

function WebUrl(Param: String): String;
begin
  if Insecure then Result := 'http' else Result := 'https';
  Result := Result + '://localhost:' + Port + '/';
end;

{ 校验密码与端口，返回错误信息，通过时为空 }
function CheckBasic(const Pwd, Confirm, PortStr: String): String;
var
  P: Integer;
begin
  Result := '';
  P := StrToIntDef(PortStr, -1);
  if Pwd = '' then Result := CustomMessage('ErrNoPwd')
  else if Pwd <> Confirm then Result := CustomMessage('ErrPwdMismatch')
  else if EnvQuote(Pwd) = '' then Result := CustomMessage('ErrPwdQuotes')
  else if (P < 1) or (P > 65535) then Result := CustomMessage('ErrPort');
end;

function CheckCert(const Cert, Key: String): String;
begin
  Result := '';
  if (Cert = '') or (Key = '') then Result := CustomMessage('ErrNoCert')
  else if not FileExists(Cert) then Result := FmtMessage(CustomMessage('ErrCertMissing'), [Cert])
  else if not FileExists(Key) then Result := FmtMessage(CustomMessage('ErrKeyMissing'), [Key])
  else if (EnvQuote(Cert) = '') or (EnvQuote(Key) = '') then Result := CustomMessage('ErrCertChars');
end;

function InitializeSetup: Boolean;
var
  Err, Pwd: String;
begin
  Result := True;
  Upgrade := FileExists(CfgFile);
  if WizardSilent and not Upgrade then
  begin
    Pwd := ExpandConstant('{param:PASSWORD|}');
    Err := CheckBasic(Pwd, Pwd, ExpandConstant('{param:PORT|8443}'));
    if (Err = '') and (ExpandConstant('{param:INSECURE|0}') <> '1') then
    begin
      Err := CheckCert(ExpandConstant('{param:CERT|}'), ExpandConstant('{param:KEY|}'));
      if Err <> '' then Err := Err + CustomMessage('SilentNeedCert');
    end;
    if Err <> '' then
    begin
      Log('静默安装参数错误：' + Err);
      SuppressibleMsgBox(FmtMessage(CustomMessage('SilentBadParams'), [Err]), mbError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;

procedure InitializeWizard;
begin
  CfgPage := CreateInputQueryPage(wpSelectDir, CustomMessage('CfgTitle'), CustomMessage('CfgDesc'), CustomMessage('CfgSub'));
  CfgPage.Add(CustomMessage('CfgPwd'), True);
  CfgPage.Add(CustomMessage('CfgConfirm'), True);
  CfgPage.Add(CustomMessage('CfgPort'), False);
  CfgPage.Values[0] := ExpandConstant('{param:PASSWORD|}');
  CfgPage.Values[1] := CfgPage.Values[0];
  CfgPage.Values[2] := ExpandConstant('{param:PORT|8443}');

  TlsPage := CreateInputOptionPage(CfgPage.ID, CustomMessage('TlsTitle'), CustomMessage('TlsDesc'), CustomMessage('TlsSub'), True, False);
  TlsPage.Add(CustomMessage('TlsOptCert'));
  TlsPage.Add(CustomMessage('TlsOptPlain'));
  if ExpandConstant('{param:INSECURE|0}') = '1' then TlsPage.SelectedValueIndex := 1
  else TlsPage.SelectedValueIndex := 0;

  CertPage := CreateInputFilePage(TlsPage.ID, CustomMessage('CertTitle'), CustomMessage('CertDesc'),
    FmtMessage(CustomMessage('CertSub'), [DataDir]));
  CertPage.Add(CustomMessage('CertCert'), CustomMessage('PemFiles') + '|*.pem;*.crt;*.cer|' + CustomMessage('AllFiles') + '|*.*', '.pem');
  CertPage.Add(CustomMessage('CertKey'), CustomMessage('PemFiles') + '|*.pem;*.key|' + CustomMessage('AllFiles') + '|*.*', '.pem');
  CertPage.Values[0] := ExpandConstant('{param:CERT|}');
  CertPage.Values[1] := ExpandConstant('{param:KEY|}');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (Upgrade and ((PageID = CfgPage.ID) or (PageID = TlsPage.ID) or (PageID = CertPage.ID)))
    or ((PageID = CertPage.ID) and (TlsPage.SelectedValueIndex = 1));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Err: String;
begin
  Result := True;
  { 静默安装时 Inno 仍逐页调用本函数，而普通 MsgBox 不受 /SUPPRESSMSGBOXES 影响会一直等待；参数已在 InitializeSetup 校验 }
  if WizardSilent then Exit;
  Err := '';
  if CurPageID = CfgPage.ID then Err := CheckBasic(CfgPage.Values[0], CfgPage.Values[1], Trim(CfgPage.Values[2]))
  else if CurPageID = CertPage.ID then Err := CheckCert(CertPage.Values[0], CertPage.Values[1])
  else if (CurPageID = TlsPage.ID) and (TlsPage.SelectedValueIndex = 1) then
    Result := MsgBox(CustomMessage('PlainWarn1') + #13#10#13#10 + CustomMessage('PlainWarn2'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  if Err <> '' then
  begin
    MsgBox(Err, mbError, MB_OK);
    Result := False;
  end;
end;

function RunCmd(const Exe, Params: String): Integer;
begin
  if not Exec(Exe, Params, '', SW_HIDE, ewWaitUntilTerminated, Result) then Result := -1;
  Log(Format('执行 %s %s → %d', [Exe, Params, Result]));
end;

{ 升级前停止服务，否则 node.exe 被占用无法替换 }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if FileExists(ServiceExe) then RunCmd(ServiceExe, 'stopwait');
end;

function XmlEsc(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '&', '&amp;', True);
  StringChangeEx(Result, '<', '&lt;', True);
  StringChangeEx(Result, '>', '&gt;', True);
end;

procedure WriteConfig;
var
  L: TArrayOfString;
begin
  SetArrayLength(L, 6);
  L[0] := '# Tether Hub 服务配置（环境变量，见 README），由安装程序生成；修改后重启服务 tether-hub 生效';
  L[1] := 'HUB_ADMIN_PASSWORD=' + EnvQuote(CfgPage.Values[0]);
  L[2] := 'HUB_PORT=' + Port;
  L[3] := 'HUB_DATA_DIR=' + EnvQuote(DataDir + '\data');
  if Insecure then
  begin
    L[4] := 'HUB_INSECURE=1';
    SetArrayLength(L, 5);
  end else begin
    L[4] := 'HUB_TLS_CERT=' + EnvQuote(CertPage.Values[0]);
    L[5] := 'HUB_TLS_KEY=' + EnvQuote(CertPage.Values[1]);
  end;
  if not SaveStringsToUTF8FileWithoutBOM(CfgFile, L, False) then RaiseException(FmtMessage(CustomMessage('ErrWriteFile'), [CfgFile]));
end;

procedure WriteServiceXml;
var
  L: TArrayOfString;
begin
  SetArrayLength(L, 14);
  L[0] := '<service>';
  L[1] := '  <id>tether-hub</id>';
  L[2] := '  <name>Tether Hub</name>';
  L[3] := '  <description>' + XmlEsc(CustomMessage('SvcDesc')) + '</description>';
  L[4] := '  <executable>' + XmlEsc(ExpandConstant('{app}\node.exe')) + '</executable>';
  L[5] := '  <arguments>--env-file="' + XmlEsc(CfgFile) + '" "' + XmlEsc(ExpandConstant('{app}\dist\main.js')) + '"</arguments>';
  L[6] := '  <workingdirectory>' + XmlEsc(DataDir) + '</workingdirectory>';
  L[7] := '  <startmode>Automatic</startmode>';
  L[8] := '  <onfailure action="restart" delay="5 sec"/>';
  L[9] := '  <resetfailure>1 hour</resetfailure>';
  L[10] := '  <stoptimeout>15 sec</stoptimeout>';
  L[11] := '  <logpath>' + XmlEsc(DataDir + '\logs') + '</logpath>';
  L[12] := '  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>';
  L[13] := '</service>';
  if not SaveStringsToUTF8File(ExpandConstant('{app}\tether-hub-service.xml'), L, False) then RaiseException(FmtMessage(CustomMessage('ErrWriteFile'), [ExpandConstant('{app}\tether-hub-service.xml')]));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then Exit;
  { 数据目录只允许 SYSTEM 与 Administrators 访问（config.env 含管理员密码） }
  ForceDirectories(DataDir);
  RunCmd(ExpandConstant('{sys}\icacls.exe'), '"' + DataDir + '" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F');
  ForceDirectories(DataDir + '\data');
  ForceDirectories(DataDir + '\logs');
  if not Upgrade then WriteConfig;
  WriteServiceXml;
  { sc query 返回 1060 表示服务不存在 }
  if RunCmd(ExpandConstant('{sys}\sc.exe'), 'query tether-hub') <> 0 then
    if RunCmd(ServiceExe, 'install') <> 0 then SuppressibleMsgBox(CustomMessage('ErrSvcInstall'), mbError, MB_OK, IDOK);
  RunCmd(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="{#FwRule}"');
  RunCmd(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall add rule name="{#FwRule}" dir=in action=allow protocol=TCP localport=' + Port);
  if RunCmd(ServiceExe, 'start') <> 0 then
    SuppressibleMsgBox(FmtMessage(CustomMessage('ErrSvcStart'), [DataDir + '\logs']), mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent and DirExists(DataDir) then
    if MsgBox(CustomMessage('DelData1') + #13#10 + DataDir + #13#10#13#10 + CustomMessage('DelData2'),
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(DataDir, True, True, True);
end;
