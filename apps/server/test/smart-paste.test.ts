import { describe, expect, it } from 'vitest';
import { parseMachineInfo, smartPasteFields } from '@atlas/shared';

const IPCONFIG = `
Windows IP Configuration

   Host Name . . . . . . . . . . . . : HDG-DC-01
   Primary Dns Suffix  . . . . . . . : harbor.local
   Node Type . . . . . . . . . . . . : Hybrid

Ethernet adapter vEthernet (Default Switch):

   Connection-specific DNS Suffix  . :
   Description . . . . . . . . . . . : Hyper-V Virtual Ethernet Adapter
   Physical Address. . . . . . . . . : 00-15-5D-AA-BB-CC
   IPv4 Address. . . . . . . . . . . : 172.20.112.1(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.240.0
   Default Gateway . . . . . . . . . :

Ethernet adapter Ethernet0:

   Description . . . . . . . . . . . : Intel(R) Ethernet Connection I219-LM
   Physical Address. . . . . . . . . : 3C-52-82-1A-2B-3C
   DHCP Enabled. . . . . . . . . . . : No
   IPv4 Address. . . . . . . . . . . : 10.20.0.10(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : fe80::1%12
                                       10.20.0.1
   DNS Servers . . . . . . . . . . . : 10.20.0.10
                                       1.1.1.1

Tunnel adapter isatap:

   Media State . . . . . . . . . . . : Media disconnected
   Autoconfiguration IPv4 Address. . : 169.254.10.20(Preferred)
`;

const SYSTEMINFO = `
Host Name:                 HDG-DC-01
OS Name:                   Microsoft Windows Server 2022 Standard
OS Version:                10.0.20348 N/A Build 20348
OS Manufacturer:           Microsoft Corporation
System Boot Time:          10/1/2026, 8:00:00 AM
System Manufacturer:       Dell Inc.
System Model:              PowerEdge R440
System Type:               x64-based PC
Total Physical Memory:     65,213 MB
Domain:                    harbor.local
Network Card(s):           1 NIC(s) Installed.
                           [01]: Intel(R) Ethernet Connection I219-LM
                                 Connection Name: Ethernet0
                                 DHCP Enabled:    No
                                 IP address(es)
                                 [01]: 10.20.0.10
                                 [02]: fe80::1c2d:3e4f:5a6b:7c8d
`;

const GET_COMPUTER_INFO = `
WindowsProductName                                      : Windows 11 Pro
OsName                                                  : Microsoft Windows 11 Pro
OsVersion                                               : 10.0.26100
BiosManufacturer                                        : LENOVO
BiosSeralNumber                                         : PF3XYZ12
CsDomain                                                : WORKGROUP
CsManufacturer                                          : LENOVO
CsModel                                                 : 21HD003AUS
CsName                                                  : FRONTDESK-02
CsPCSystemType                                          : Mobile
OsProductType                                           : WorkStation
`;

const MAC = `
Hardware:

    Hardware Overview:

      Model Name: MacBook Pro
      Model Identifier: Mac15,3
      Chip: Apple M3
      Memory: 16 GB
      Serial Number (system): C02XG2JHMD6M
      Hardware UUID: 1A2B3C4D-0000-0000-0000-000000000000
`;

const HOSTNAMECTL = `
 Static hostname: web01
       Icon name: computer-server
         Chassis: server
      Machine ID: 0123456789abcdef
Operating System: Ubuntu 22.04.3 LTS
          Kernel: Linux 5.15.0-91-generic
    Architecture: x86-64
 Hardware Vendor: Dell Inc.
  Hardware Model: PowerEdge R640
`;

describe('smart paste', () => {
  it('reads ipconfig /all: the adapter with a gateway first, with its MAC', () => {
    const info = parseMachineInfo(IPCONFIG);
    expect(info.hostname).toBe('HDG-DC-01');
    // The Hyper-V switch has no gateway; the link-local address on the tunnel is left out.
    expect(info.ipAddresses).toEqual(['10.20.0.10', '172.20.112.1']);
    expect(info.macAddress).toBe('3C:52:82:1A:2B:3C');
  });

  it('reads systeminfo, and ipconfig and systeminfo pasted together', () => {
    const info = parseMachineInfo(SYSTEMINFO);
    expect(info).toMatchObject({
      hostname: 'HDG-DC-01',
      ipAddresses: ['10.20.0.10'],
      manufacturer: 'Dell Inc.',
      model: 'PowerEdge R440',
      operatingSystem: 'Microsoft Windows Server 2022 Standard (10.0.20348 Build 20348)',
      type: 'Server',
      domain: 'harbor.local',
    });
    const both = parseMachineInfo(`${IPCONFIG}\n${SYSTEMINFO}`);
    expect(both).toMatchObject({
      macAddress: '3C:52:82:1A:2B:3C',
      model: 'PowerEdge R440',
      ipAddresses: ['10.20.0.10', '172.20.112.1'],
    });
  });

  it('reads Get-ComputerInfo, Microsoft’s misspelt serial number and all', () => {
    expect(parseMachineInfo(GET_COMPUTER_INFO)).toEqual({
      hostname: 'FRONTDESK-02',
      ipAddresses: [],
      manufacturer: 'LENOVO',
      model: '21HD003AUS',
      serialNumber: 'PF3XYZ12',
      operatingSystem: 'Windows 11 Pro (10.0.26100)',
      type: 'Laptop',
    });
  });

  it('reads a Mac’s system_profiler and Linux’s hostnamectl', () => {
    expect(parseMachineInfo(MAC)).toMatchObject({
      manufacturer: 'Apple',
      model: 'MacBook Pro',
      serialNumber: 'C02XG2JHMD6M',
      type: 'Laptop',
    });
    expect(parseMachineInfo(HOSTNAMECTL)).toMatchObject({
      hostname: 'web01',
      manufacturer: 'Dell Inc.',
      model: 'PowerEdge R640',
      operatingSystem: 'Ubuntu 22.04.3 LTS',
      type: 'Server',
    });
  });

  it('ignores placeholders and text that isn’t a device', () => {
    expect(parseMachineInfo('System Manufacturer: To Be Filled By O.E.M.\nSystem Model: Default string')).toEqual({
      ipAddresses: [],
    });
    expect(parseMachineInfo('Just some notes about the printer.')).toEqual({ ipAddresses: [] });
  });

  it('matches what it found to a layout’s fields by key or label', () => {
    const fields = [
      { key: 'type', label: 'Type', type: 'select', options: ['Server', 'Workstation', 'Laptop'] },
      { key: 'hostname', label: 'Hostname', type: 'text' },
      { key: 'ip_address', label: 'IP address', type: 'ip' },
      { key: 'mac_address', label: 'MAC address', type: 'text' },
      { key: 'manufacturer', label: 'Manufacturer', type: 'text' },
      { key: 'model', label: 'Model', type: 'text' },
      { key: 'serial_number', label: 'Serial number', type: 'text' },
      { key: 'operating_system', label: 'Operating system', type: 'text' },
      { key: 'purchase_date', label: 'Purchase date', type: 'date' },
    ];
    expect(smartPasteFields(parseMachineInfo(`${IPCONFIG}\n${SYSTEMINFO}`), fields)).toEqual([
      { key: 'hostname', label: 'Hostname', value: 'HDG-DC-01' },
      { key: 'ip_address', label: 'IP address', value: '10.20.0.10' },
      { key: 'mac_address', label: 'MAC address', value: '3C:52:82:1A:2B:3C' },
      { key: 'manufacturer', label: 'Manufacturer', value: 'Dell Inc.' },
      { key: 'model', label: 'Model', value: 'PowerEdge R440' },
      {
        key: 'operating_system',
        label: 'Operating system',
        value: 'Microsoft Windows Server 2022 Standard (10.0.20348 Build 20348)',
      },
      { key: 'type', label: 'Type', value: 'Server' },
    ]);
    // A custom layout with its own names, and a select without the value: left alone.
    expect(
      smartPasteFields(parseMachineInfo(GET_COMPUTER_INFO), [
        { key: 'pc', label: 'Computer name', type: 'text' },
        { key: 'svc', label: 'Service tag', type: 'text' },
        { key: 'kind', label: 'Device type', type: 'select', options: ['Desktop'] },
      ]),
    ).toEqual([
      { key: 'pc', label: 'Computer name', value: 'FRONTDESK-02' },
      { key: 'svc', label: 'Service tag', value: 'PF3XYZ12' },
    ]);
  });
});
