; Tether Hub Windows 安装程序（Inno Setup 6.5+）。由 scripts/package.ts 调用 ISCC 编译，传入：
;   /DAppVersion=<版本> /DPayloadDir=<组装好的应用目录> /DWinSW=<WinSW-x64.exe> /DZhIsl=<ChineseSimplified.isl>
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

[Languages]
Name: "zh"; MessagesFile: "{#ZhIsl}"

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
Name: "{group}\打开管理网页"; Filename: "{code:WebUrl}"
Name: "{group}\Token 命令行"; Filename: "{cmd}"; Parameters: "/k ""{app}\tether-hub-token.cmd"""; WorkingDir: "{app}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"

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
  if Pwd = '' then Result := '请设置管理员密码'
  else if Pwd <> Confirm then Result := '两次输入的密码不一致'
  else if EnvQuote(Pwd) = '' then Result := '密码不能同时包含单引号、反引号与双引号'
  else if (P < 1) or (P > 65535) then Result := '端口应为 1–65535 的整数';
end;

function CheckCert(const Cert, Key: String): String;
begin
  Result := '';
  if (Cert = '') or (Key = '') then Result := '请选择证书与私钥文件'
  else if not FileExists(Cert) then Result := '证书文件不存在：' + Cert
  else if not FileExists(Key) then Result := '私钥文件不存在：' + Key
  else if (EnvQuote(Cert) = '') or (EnvQuote(Key) = '') then Result := '证书路径包含无法写入配置的字符';
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
      if Err <> '' then Err := Err + '（静默安装需提供 /CERT 与 /KEY，或 /INSECURE=1）';
    end;
    if Err <> '' then
    begin
      Log('静默安装参数错误：' + Err);
      SuppressibleMsgBox('静默安装参数错误：' + Err, mbError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;

procedure InitializeWizard;
begin
  CfgPage := CreateInputQueryPage(wpSelectDir, '管理员与端口', '设置网页管理员密码与监听端口',
    '端口同时用于管理网页与各机器 Tether 的连接，安装时会为它添加防火墙入站规则。');
  CfgPage.Add('管理员密码：', True);
  CfgPage.Add('确认密码：', True);
  CfgPage.Add('端口：', False);
  CfgPage.Values[0] := ExpandConstant('{param:PASSWORD|}');
  CfgPage.Values[1] := CfgPage.Values[0];
  CfgPage.Values[2] := ExpandConstant('{param:PORT|8443}');

  TlsPage := CreateInputOptionPage(CfgPage.ID, '传输加密', '选择 hub 的连接方式',
    '推荐使用 TLS 证书（https / wss）。没有证书时可选明文，但 token 与管理员密码会以明文传输。', True, False);
  TlsPage.Add('使用 TLS 证书（推荐）');
  TlsPage.Add('不使用证书，明文 HTTP / ws（HUB_INSECURE=1，仅限本机或可信局域网）');
  if ExpandConstant('{param:INSECURE|0}') = '1' then TlsPage.SelectedValueIndex := 1
  else TlsPage.SelectedValueIndex := 0;

  CertPage := CreateInputFilePage(TlsPage.ID, 'TLS 证书', '选择 PEM 格式的证书与私钥',
    '服务直接读取这两个文件，请放在不会被移动或删除的位置（例如 ' + DataDir + '）。');
  CertPage.Add('证书：', 'PEM 文件|*.pem;*.crt;*.cer|所有文件|*.*', '.pem');
  CertPage.Add('私钥：', 'PEM 文件|*.pem;*.key|所有文件|*.*', '.pem');
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
  Err := '';
  if CurPageID = CfgPage.ID then Err := CheckBasic(CfgPage.Values[0], CfgPage.Values[1], Trim(CfgPage.Values[2]))
  else if CurPageID = CertPage.ID then Err := CheckCert(CertPage.Values[0], CertPage.Values[1])
  else if (CurPageID = TlsPage.ID) and (TlsPage.SelectedValueIndex = 1) then
    Result := MsgBox('明文模式下，管理网页与各机器的连接都不加密，token 与管理员密码可被同一网络中的人窃听。' + #13#10#13#10 +
      '仅建议在本机或可信局域网中使用。确定继续？', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
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
  if not SaveStringsToUTF8FileWithoutBOM(CfgFile, L, False) then RaiseException('写入 ' + CfgFile + ' 失败');
end;

procedure WriteServiceXml;
var
  L: TArrayOfString;
begin
  SetArrayLength(L, 14);
  L[0] := '<service>';
  L[1] := '  <id>tether-hub</id>';
  L[2] := '  <name>Tether Hub</name>';
  L[3] := '  <description>Tether 自托管管理服务器</description>';
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
  if not SaveStringsToUTF8File(ExpandConstant('{app}\tether-hub-service.xml'), L, False) then RaiseException('写入服务配置失败');
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
    if RunCmd(ServiceExe, 'install') <> 0 then SuppressibleMsgBox('注册服务失败，详见安装日志', mbError, MB_OK, IDOK);
  RunCmd(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="{#FwRule}"');
  RunCmd(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall add rule name="{#FwRule}" dir=in action=allow protocol=TCP localport=' + Port);
  if RunCmd(ServiceExe, 'start') <> 0 then
    SuppressibleMsgBox('服务启动失败，请查看 ' + DataDir + '\logs 中的日志', mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent and DirExists(DataDir) then
    if MsgBox('是否同时删除配置与数据？' + #13#10 + DataDir + #13#10#13#10 +
      '其中包括管理员密码、机器 token 与审计日志；保留则重新安装后可继续使用。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(DataDir, True, True, True);
end;
