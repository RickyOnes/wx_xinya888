import requests
import json

# 请求头
headers = {
    "accept": "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "anti-content":"0asAfx5E-wCEsKSlfci0AQrnbaXfRwRO6jVJWAmUAg688Wzsy0LXiOpjVi9RVSDXcDRsbaX0iZlO_asyNyOzb0y2rEjYtA2u4orkLk6T6K4Rj--5y2Lsocl1cL759qG8smxHT6__i-7XVygyIoE3Y0u9nPD84mYoT0_hiUr-Qb2LEQOpdxp75gq6BDMxrCg_2iVMNtb4yqMEGYa4ZpM-Qg2UnrGWKWxB30AqSLsOAmjqfqY5Gl2i0G8TbaDCWw4i18Xxb6yWQkc5nA2i2Y85EYoCQwOiHzXJzi9i2HBFzNCMGi9zV6g8QBzUA6lWQASyomE1Y35oXWEiT3Pp6S6kBBddvf_dBqFH3RDHsAT-eu_-CigAOS3hWK1tDSfhH-3xWH3w_-1wWI3Z7-fLk-3I7UF0scyljamBSV8O6SPBeKDB2he-1Oe-xZk-vCEBACk-1ODB2-E-2FEz1VE25TLwPCgDMIwzfFezmVDdAhD73zeU3lKDL1SKt9w0HTcorxEa_igau29YN2k9_VCe-tcdBs-KISCzs4TUxIA-h_uzkfok-qhe8q-Kl6cgAGHKLlTU3-uIh4A-1quHLSCSsBdS3hID8VZK-m9CCH2Zz-fweUaGkb1LTZ32K8PCFqG4PQyxfq4utNNy30PoQYbUO5XisfMrJ2oSYqpv0MGPUc5qMYt0Ifvpc9-66x9HfhpS3Lecy04luXZYnXijN-bX09oIna3y54IyXUxJue81mb8x5Ukzwr_sxVhX03CECP9J0JyBeVfELTM"
    "cache-control": "max-age=0",
    "content-type": "application/json",
    "cookie": "api_uid=Ci8VIGmB3qQnRwCY1ZqBAg==; rckk=oGkzFvJ6hnlU8EDnmzuGWWgSzxXjdV7u; _bee=oGkzFvJ6hnlU8EDnmzuGWWgSzxXjdV7u; ru1k=981885b5-584c-4ebd-8408-ccbb67af75e2; _f77=981885b5-584c-4ebd-8408-ccbb67af75e2; ru2k=c7525450-0fe9-4cdb-8503-a489741822d5; _a42=c7525450-0fe9-4cdb-8503-a489741822d5; _nano_fp=Xpm8X0galpgJn5TYno_tYiguOKWKLn4eN9r939oy; windows_app_shop_token_23=eyJ0IjoiNExkLzZUOW96R3FMTFhxcDRHMzQzNFdtUHpkbUJxZEdLaC9WalRtUk9naEREd3R1TnpJWGpkK3I3VXZJcklzOCIsInYiOjEsInMiOjIzLCJtIjoyMjMzNDM2NjQsInUiOjE0MTI3OTg0M30; PASS_ID=1-Cya4o/VGM+OyoAtRy/Skd6K055/B5gUCjV4cNYdjrIUBgx6VIwf9vda9yCf7pDDXd9iCS+VXErm1T0AbTGqhNQ_416666329_141279844",
    "origin": "https://mc.pinduoduo.com",
    "priority": "u=1, i",
    "referer": "https://mc.pinduoduo.com/ddmc-mms/order/management",
    "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Microsoft Edge";v="144"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0"
}

# 请求数据
data = {
    "page": 1,
    "pageSize": 10,
    "areaId": 19881233,
    "warehouseIds": [12009, 12079, 18902, 19099],
    "startSessionTime": 1770119188904,
    "endSessionTime": 1770119188904
}

# 发送请求
url = "https://mc.pinduoduo.com/cartman-mms/orderManagement/pageQueryDetail"
response = requests.post(url, headers=headers, json=data)
result = response.json()
print(f"请求结果：{result}")

if (result["success"]):
    # 修改 1：提取 resultList（注意判空）
    order_list = result["result"]["resultList"]

    # 修改 2：保存到 JSON 文件
    with open("D:\\1.json", "w", encoding="utf-8") as f:
        json.dump(order_list, f, ensure_ascii=False, indent=2)

    print(f"✅ 保存成功，共 {len(order_list)} 条订单")
    print(f"总订单数: {result['result']['total']}")

