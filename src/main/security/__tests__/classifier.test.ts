import { describe, it, expect } from 'vitest';
import { classifyCommand } from '../classifier.js';

describe('classifyCommand', () => {
  describe('READ commands', () => {
    const readCmds = [
      'ls -la',
      'cat /etc/passwd',
      'grep error /var/log/syslog',
      'ps aux',
      'df -h',
      'systemctl status nginx',
      'systemctl is-enabled nginx',
      'docker ps',
      'docker images',
      'docker logs web',
      'git status',
      'git log --oneline -5',
      'git diff',
      'curl -s http://localhost:8080/health',
      'free -m',
      'uptime',
      'ss -tlnp',
      'journalctl -u nginx --since "1 hour ago"',
      // fd-to-fd redirections must NOT be classified as file writes
      'ls -l /tmp/cmdb_ck2.txt 2>&1',
      'cat /etc/passwd 2>&1',
      'ls 2>&1 | head',
      'echo msg 1>&2',
      'git status 2>&1',
      '>&2 echo hi',
    ];

    for (const cmd of readCmds) {
      it(`classifies "${cmd}" as READ`, () => {
        expect(classifyCommand(cmd)).toBe('READ');
      });
    }
  });

  describe('WRITE commands', () => {
    const writeCmds = [
      'systemctl restart nginx',
      'systemctl stop docker',
      'systemctl enable redis',
      'touch /tmp/test',
      'mkdir -p /opt/app',
      'cp file.txt file.bak',
      'mv old.txt new.txt',
      'chmod 755 script.sh',
      'echo hello > /tmp/test',
      'echo append >> /tmp/log',
      'docker restart web',
      'docker rm old_container',
      'docker run -d nginx',
      'git commit -m "fix"',
      'git push origin main',
      'apt install nginx',
      'apt remove old-package',
      'pip install flask',
    ];

    for (const cmd of writeCmds) {
      it(`classifies "${cmd}" as WRITE`, () => {
        expect(classifyCommand(cmd)).toBe('WRITE');
      });
    }
  });

  describe('SUDO commands', () => {
    const sudoCmds = [
      'sudo systemctl restart nginx',
      'sudo apt update',
      'sudo cat /etc/shadow',
      'su -c "systemctl restart nginx"',
    ];

    for (const cmd of sudoCmds) {
      it(`classifies "${cmd}" as SUDO`, () => {
        expect(classifyCommand(cmd)).toBe('SUDO');
      });
    }
  });

  describe('dual-purpose commands', () => {
    it('classifies "apt list" as READ', () => {
      expect(classifyCommand('apt list --installed')).toBe('READ');
    });

    it('classifies "apt search" as READ', () => {
      expect(classifyCommand('apt search nginx')).toBe('READ');
    });

    it('classifies "apt install" as WRITE', () => {
      expect(classifyCommand('apt install nginx')).toBe('WRITE');
    });

    it('classifies "apt remove" as WRITE', () => {
      expect(classifyCommand('apt remove nginx')).toBe('WRITE');
    });

    it('classifies "docker exec" as WRITE', () => {
      expect(classifyCommand('docker exec -it web sh')).toBe('WRITE');
    });

    // ip (iproute2)
    it('classifies "ip addr show" as READ', () => {
      expect(classifyCommand('ip addr show')).toBe('READ');
    });
    it('classifies "ip -br addr" as READ', () => {
      expect(classifyCommand('ip -br addr')).toBe('READ');
    });
    it('classifies "ip addr add" as WRITE', () => {
      expect(classifyCommand('ip addr add 192.168.1.1/24 dev eth0')).toBe('WRITE');
    });
    it('classifies "ip link set" as WRITE', () => {
      expect(classifyCommand('ip link set eth0 up')).toBe('WRITE');
    });
    it('classifies "ip route del" as WRITE', () => {
      expect(classifyCommand('ip route del default')).toBe('WRITE');
    });

    // ifconfig
    it('classifies bare "ifconfig" as READ', () => {
      expect(classifyCommand('ifconfig')).toBe('READ');
    });
    it('classifies "ifconfig eth0" as READ', () => {
      expect(classifyCommand('ifconfig eth0')).toBe('READ');
    });
    it('classifies "ifconfig eth0 IP" as WRITE', () => {
      expect(classifyCommand('ifconfig eth0 192.168.1.1')).toBe('WRITE');
    });
    it('classifies "ifconfig eth0 up" as WRITE', () => {
      expect(classifyCommand('ifconfig eth0 up')).toBe('WRITE');
    });

    // route
    it('classifies "route -n" as READ', () => {
      expect(classifyCommand('route -n')).toBe('READ');
    });
    it('classifies "route add" as WRITE', () => {
      expect(classifyCommand('route add default gw 192.168.1.1')).toBe('WRITE');
    });
    it('classifies "route del" as WRITE', () => {
      expect(classifyCommand('route del -net 10.0.0.0')).toBe('WRITE');
    });

    // arp
    it('classifies "arp -a" as READ', () => {
      expect(classifyCommand('arp -a')).toBe('READ');
    });
    it('classifies "arp -s" as WRITE', () => {
      expect(classifyCommand('arp -s 192.168.1.1 aa:bb:cc:dd:ee:ff')).toBe('WRITE');
    });
    it('classifies "arp -d" as WRITE', () => {
      expect(classifyCommand('arp -d 192.168.1.1')).toBe('WRITE');
    });

    // dpkg
    it('classifies "dpkg -l" as READ', () => {
      expect(classifyCommand('dpkg -l')).toBe('READ');
    });
    it('classifies "dpkg -s" as READ', () => {
      expect(classifyCommand('dpkg -s nginx')).toBe('READ');
    });
    it('classifies "dpkg -i" as WRITE', () => {
      expect(classifyCommand('dpkg -i pkg.deb')).toBe('WRITE');
    });
    it('classifies "dpkg -r" as WRITE', () => {
      expect(classifyCommand('dpkg -r nginx')).toBe('WRITE');
    });
    it('classifies "dpkg --purge" as WRITE', () => {
      expect(classifyCommand('dpkg --purge nginx')).toBe('WRITE');
    });

    // rpm
    it('classifies "rpm -qa" as READ', () => {
      expect(classifyCommand('rpm -qa')).toBe('READ');
    });
    it('classifies "rpm -qi" as READ', () => {
      expect(classifyCommand('rpm -qi nginx')).toBe('READ');
    });
    it('classifies "rpm -i" as WRITE', () => {
      expect(classifyCommand('rpm -i pkg.rpm')).toBe('WRITE');
    });
    it('classifies "rpm -U" as WRITE', () => {
      expect(classifyCommand('rpm -U pkg.rpm')).toBe('WRITE');
    });
    it('classifies "rpm -e" as WRITE', () => {
      expect(classifyCommand('rpm -e nginx')).toBe('WRITE');
    });

    // sed
    it('classifies "sed s/a/b/" as READ', () => {
      expect(classifyCommand("sed 's/a/b/' file")).toBe('READ');
    });
    it('classifies "sed -n" as READ', () => {
      expect(classifyCommand("sed -n 'p' file")).toBe('READ');
    });
    it('classifies "sed -i" as WRITE', () => {
      expect(classifyCommand("sed -i 's/a/b/' file")).toBe('WRITE');
    });
    it('classifies "sed --in-place" as WRITE', () => {
      expect(classifyCommand("sed --in-place 's/a/b/' file")).toBe('WRITE');
    });
    it('classifies "sed -i.bak" as WRITE', () => {
      expect(classifyCommand("sed -i.bak 's/a/b/' file")).toBe('WRITE');
    });

    // mount
    it('classifies bare "mount" as READ', () => {
      expect(classifyCommand('mount')).toBe('READ');
    });
    it('classifies "mount -l" as READ', () => {
      expect(classifyCommand('mount -l')).toBe('READ');
    });
    it('classifies "mount DEV DIR" as WRITE', () => {
      expect(classifyCommand('mount /dev/sda1 /mnt')).toBe('WRITE');
    });
    it('classifies "mount -t ext4 DEV DIR" as WRITE', () => {
      expect(classifyCommand('mount -t ext4 /dev/sda1 /mnt')).toBe('WRITE');
    });

    // tee is always WRITE (writes to file)
    it('classifies "tee /tmp/x" as WRITE', () => {
      expect(classifyCommand('tee /tmp/x')).toBe('WRITE');
    });
    it('classifies "tee -a /tmp/x" as WRITE', () => {
      expect(classifyCommand('tee -a /tmp/x')).toBe('WRITE');
    });
  });

  describe('edge cases', () => {
    it('classifies empty string as READ', () => {
      expect(classifyCommand('')).toBe('READ');
    });

    it('classifies unknown command as WRITE (safe default)', () => {
      expect(classifyCommand('some-unknown-command --flag')).toBe('WRITE');
    });

    it('handles full path commands', () => {
      expect(classifyCommand('/usr/bin/ls -la')).toBe('READ');
      expect(classifyCommand('/sbin/reboot')).toBe('WRITE');
    });
  });
});
