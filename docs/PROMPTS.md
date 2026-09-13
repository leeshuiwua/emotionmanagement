# XML 提示词配置
统一入口：src/server/config/prompts.xml。修改后重新构建并重启，代码与XML成套发布。
- intent/system：ledger / insight / both / unsupported / clarify 的JSON结构和识别规则。{{today}} 为北京时间日期。entries为1到10笔收支；兼容旧单笔entry结果。
- intent/clarification：真正含糊输入的澄清；unsupported：明确不支持的消息；unavailable：模型服务故障。不得混为一种错误。
- intent/requestTimeoutMs、maxTokens：分类预算；DeepSeek V4 使用非思考 JSON 模式。
- mood/saved：微信记录成功的简短反馈；mood/system：后台心境总结的JSON格式、依据及边界。
- mood/requestTimeoutMs、maxTokens、sampleLimit：后台分析预算和最近样本量。默认50条，每条最多2000字符；接口标记采样或截短。
- ledger/preview：自动入账后的回执（保留旧节点名兼容维护），支持 date/kind/amount/category/account 占位符。
- ledger/summary：month/income/expense/net。其余草稿文案仅用于旧记录兼容。
- replies/crisis*：安全优先反馈。
- coach 与 replies/fallback：保留旧单次心理回复模块的兼容配置，新微信心情链路不再调用它。

解析严格校验 XML、必填字段和占位符，不允许DTD/实体。所有模型输出都当作不可信数据，结构与财务字段由服务端校验；模型分析证据ID只能引用本次本人记录。
此配置不含密钥。非诊断规则和证据ID校验无法证明每个模型结论正确，真实模型仍需单独评测。
